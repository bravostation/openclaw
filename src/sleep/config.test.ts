import { describe, expect, it } from "vitest";

import {
  resolveSleepConfig,
  isSleepEnabled,
  DEFAULT_SLEEP_WINDOW,
  DEFAULT_MIN_IDLE_MINUTES,
  DEFAULT_MEMORY_PRUNING_MAX_AGE_HOURS,
  DEFAULT_MEMORY_PROMOTION_MIN_REINFORCEMENTS,
} from "./config.js";
import type { OpenClawConfig } from "../config/config.js";

describe("sleep/config", () => {
  describe("resolveSleepConfig", () => {
    it("returns null when sleep is disabled", () => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            sleep: { enabled: false },
          },
        },
      };
      expect(resolveSleepConfig(cfg)).toBeNull();
    });

    it("returns null when sleep config is missing", () => {
      const cfg: OpenClawConfig = {};
      expect(resolveSleepConfig(cfg)).toBeNull();
    });

    it("returns resolved config with defaults when enabled", () => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            sleep: { enabled: true },
          },
        },
      };
      const resolved = resolveSleepConfig(cfg);
      expect(resolved).not.toBeNull();
      expect(resolved!.enabled).toBe(true);
      expect(resolved!.window).toBe(DEFAULT_SLEEP_WINDOW);
      expect(resolved!.minIdleMinutes).toBe(DEFAULT_MIN_IDLE_MINUTES);
    });

    it("parses custom sleep window correctly", () => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            sleep: {
              enabled: true,
              window: "02:00-05:30",
            },
          },
        },
      };
      const resolved = resolveSleepConfig(cfg);
      expect(resolved!.window).toBe("02:00-05:30");
      expect(resolved!.windowStart).toEqual({ hour: 2, minute: 0 });
      expect(resolved!.windowEnd).toEqual({ hour: 5, minute: 30 });
    });

    it("returns null for invalid window format", () => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            sleep: {
              enabled: true,
              window: "invalid",
            },
          },
        },
      };
      expect(resolveSleepConfig(cfg)).toBeNull();
    });

    it("resolves shallow sleep defaults", () => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            sleep: { enabled: true },
          },
        },
      };
      const resolved = resolveSleepConfig(cfg);
      expect(resolved!.shallow.enabled).toBe(true);
      expect(resolved!.shallow.tasks.configValidation).toBe(true);
      expect(resolved!.shallow.updates.enabled).toBe(true);
      expect(resolved!.shallow.security.enabled).toBe(true);
      expect(resolved!.shallow.radar.enabled).toBe(true);
    });

    it("resolves deep sleep defaults", () => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            sleep: { enabled: true },
          },
        },
      };
      const resolved = resolveSleepConfig(cfg);
      expect(resolved!.deep.enabled).toBe(true);
      expect(resolved!.deep.memoryPruning.enabled).toBe(true);
      expect(resolved!.deep.memoryPruning.maxAgeHours).toBe(DEFAULT_MEMORY_PRUNING_MAX_AGE_HOURS);
      expect(resolved!.deep.memoryCompaction.enabled).toBe(true);
      expect(resolved!.deep.memoryPromotion.enabled).toBe(true);
      expect(resolved!.deep.memoryPromotion.minReinforcementsForLongTerm).toBe(
        DEFAULT_MEMORY_PROMOTION_MIN_REINFORCEMENTS,
      );
      expect(resolved!.deep.coreMemory.enabled).toBe(true);
    });

    it("allows overriding deep sleep settings", () => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            sleep: {
              enabled: true,
              deep: {
                memoryPruning: {
                  maxAgeHours: 48,
                },
                memoryPromotion: {
                  minReinforcementsForLongTerm: 5,
                  minConfidenceForLongTerm: 0.8,
                },
              },
            },
          },
        },
      };
      const resolved = resolveSleepConfig(cfg);
      expect(resolved!.deep.memoryPruning.maxAgeHours).toBe(48);
      expect(resolved!.deep.memoryPromotion.minReinforcementsForLongTerm).toBe(5);
      expect(resolved!.deep.memoryPromotion.minConfidenceForLongTerm).toBe(0.8);
    });

    it("allows disabling specific shallow tasks", () => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            sleep: {
              enabled: true,
              shallow: {
                tasks: {
                  configValidation: false,
                },
                security: {
                  enabled: false,
                },
              },
            },
          },
        },
      };
      const resolved = resolveSleepConfig(cfg);
      expect(resolved!.shallow.tasks.configValidation).toBe(false);
      expect(resolved!.shallow.tasks.credentialsCheck).toBe(true); // default
      expect(resolved!.shallow.security.enabled).toBe(false);
    });
  });

  describe("isSleepEnabled", () => {
    it("returns false when config is undefined", () => {
      expect(isSleepEnabled(undefined)).toBe(false);
    });

    it("returns false when sleep is not configured", () => {
      expect(isSleepEnabled({})).toBe(false);
    });

    it("returns false when sleep.enabled is false", () => {
      expect(
        isSleepEnabled({
          agents: { defaults: { sleep: { enabled: false } } },
        }),
      ).toBe(false);
    });

    it("returns true when sleep.enabled is true", () => {
      expect(
        isSleepEnabled({
          agents: { defaults: { sleep: { enabled: true } } },
        }),
      ).toBe(true);
    });
  });
});
