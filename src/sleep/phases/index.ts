/**
 * Sleep phases index.
 */

export {
  runShallowSleep,
  summarizeShallowSleep,
  type ShallowSleepResult,
  type ShallowSleepOptions,
  type ShallowSleepSummary,
} from "./shallow.js";

export {
  runDeepSleep,
  summarizeDeepSleep,
  type DeepSleepResult,
  type DeepSleepOptions,
  type DeepSleepSummary,
  type LlmReflectionResult,
} from "./deep.js";
