export const NS = 'baro' as const

export const en = {
  'panel.title': 'baro runs',
  'panel.aria': 'baro runs',
  'panel.empty': 'No baro runs yet. Delegate a goal with the baro tool and it shows up here.',
  'panel.error': 'Could not read run state',
  'status.running': 'running',
  'status.completed': 'completed',
  'status.error': 'failed',
  'status.max-tokens': 'token ceiling',
  'status.aborted': 'cancelled',
  'run.progress': 'stories',
  'run.pr': 'pull request',
  'run.milestones': 'milestones',
  'trigger.aria': 'baro runs',
} as const

export const zh = {
  'panel.title': 'baro 运行',
  'panel.aria': 'baro 运行',
  'panel.empty': '还没有 baro 运行。用 baro 工具委派一个目标，它会出现在这里。',
  'panel.error': '无法读取运行状态',
  'status.running': '运行中',
  'status.completed': '已完成',
  'status.error': '失败',
  'status.max-tokens': '达到 token 上限',
  'status.aborted': '已取消',
  'run.progress': '故事',
  'run.pr': '拉取请求',
  'run.milestones': '里程碑',
  'trigger.aria': 'baro 运行',
} as const

export type BaroKey = keyof typeof en
