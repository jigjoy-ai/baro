use std::collections::{HashMap, HashSet};

use crate::app::{StoryState, StoryStatus};

/// Rebuild the TUI's full plan levels after an authoritative replan event.
/// Missing/skipped dependencies are treated as already satisfied, matching
/// the orchestrator's remaining-work view. A cycle leaves the previous UI
/// projection intact instead of rendering a misleading partial graph.
pub fn rebuild_dag_levels(stories: &[StoryState]) -> Option<Vec<Vec<String>>> {
    let active: Vec<&StoryState> = stories
        .iter()
        .filter(|story| story.status != StoryStatus::Skipped)
        .collect();
    if active.is_empty() {
        return Some(Vec::new());
    }

    let active_ids: HashSet<&str> = active.iter().map(|story| story.id.as_str()).collect();
    let order: HashMap<&str, usize> = active
        .iter()
        .enumerate()
        .map(|(index, story)| (story.id.as_str(), index))
        .collect();
    let mut in_degree: HashMap<&str, usize> = HashMap::new();
    let mut dependents: HashMap<&str, Vec<&str>> = HashMap::new();

    for story in &active {
        let dependencies: HashSet<&str> = story
            .depends_on
            .iter()
            .map(String::as_str)
            .filter(|dependency| active_ids.contains(dependency))
            .collect();
        in_degree.insert(story.id.as_str(), dependencies.len());
        for dependency in dependencies {
            dependents
                .entry(dependency)
                .or_default()
                .push(story.id.as_str());
        }
    }

    let mut queue: Vec<&str> = active
        .iter()
        .filter(|story| in_degree.get(story.id.as_str()) == Some(&0))
        .map(|story| story.id.as_str())
        .collect();
    let mut levels = Vec::new();
    let mut placed = 0usize;

    while !queue.is_empty() {
        queue.sort_by_key(|story_id| order.get(story_id).copied().unwrap_or(usize::MAX));
        placed += queue.len();
        levels.push(queue.iter().map(|story_id| (*story_id).to_string()).collect());

        let mut next = Vec::new();
        for story_id in queue {
            for dependent in dependents.get(story_id).into_iter().flatten() {
                if let Some(remaining) = in_degree.get_mut(dependent) {
                    *remaining -= 1;
                    if *remaining == 0 {
                        next.push(*dependent);
                    }
                }
            }
        }
        queue = next;
    }

    (placed == active.len()).then_some(levels)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rebuilds_levels_and_fails_closed_on_cycles() {
        let stories = vec![
            StoryState::new("S1".into(), "one".into(), vec![], StoryStatus::Complete),
            StoryState::new(
                "S2".into(),
                "two".into(),
                vec!["S1".into()],
                StoryStatus::Pending,
            ),
            StoryState::new(
                "S3".into(),
                "three".into(),
                vec!["S1".into()],
                StoryStatus::Pending,
            ),
        ];
        assert_eq!(
            rebuild_dag_levels(&stories),
            Some(vec![vec!["S1".into()], vec!["S2".into(), "S3".into()]])
        );

        let cycle = vec![
            StoryState::new(
                "S1".into(),
                "one".into(),
                vec!["S2".into()],
                StoryStatus::Pending,
            ),
            StoryState::new(
                "S2".into(),
                "two".into(),
                vec!["S1".into()],
                StoryStatus::Pending,
            ),
        ];
        assert_eq!(rebuild_dag_levels(&cycle), None);
    }
}
