/** Infrastructure-level provider constants.
 *
 * Moved from application/agent/agentTaskService.ts because these are
 * provider identifiers — the MVP decrypt provider is an infrastructure
 * implementation, so its IDs belong with the infrastructure layer.
 */
export const MVP_PROVIDER_ID = "mvp.local.decrypt";
export const MVP_CAPABILITY_ID = "music.decrypt";
