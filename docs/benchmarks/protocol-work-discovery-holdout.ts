import type { RegisterMsg, RejectMsg, ToRunner } from "./protocol.js"

const unpaired: RegisterMsg = {
    t: "register",
    runnerId: "runner-1",
    backends: ["claude"],
    workspaceIds: ["workspace-1"],
    version: "1.0.0",
}

const paired: RegisterMsg = {
    ...unpaired,
    token: "rt_example",
}

const rejected: RejectMsg = {
    t: "rejected",
    reason: "unknown or expired pairing token",
}

const inbound: ToRunner = rejected
if (inbound.t === "rejected") {
    const reason: string = inbound.reason
    void reason
}

void paired
