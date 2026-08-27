/** Application-level logger service — Presentation depends on this, not Infrastructure directly.
 *
 * Follows three-tier frontend architecture:
 *   Presentation → Application → Infrastructure
 *
 * Application layer may import Infrastructure (it orchestrates),
 * but Presentation must only depend on Application.
 */
export { debugError, debugInfo, debugWarn } from "../../infrastructure/logging/debugLogger";
