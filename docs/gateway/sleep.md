---
summary: "Sleep system: scheduled memory consolidation and system maintenance"
read_when:
  - Configuring sleep cycles for your agent
  - Understanding memory hierarchy and promotion
  - Tuning maintenance tasks during idle periods
---
# Sleep System

The Sleep System is a scheduled, offline-first cognitive maintenance and memory consolidation process that runs during periods of user inactivity.

## Overview

Sleep mirrors human cognitive processes:
- **Shallow Sleep**: Health checks, security scans, update detection (fast, interruptible)
- **Deep Sleep**: Memory consolidation, pruning, promotion, core memory extraction (heavier, atomic steps)

## Quick Start

Enable sleep in your config:

```json5
{
  agents: {
    defaults: {
      sleep: {
        enabled: true,
        window: "03:00-06:00",  // Local time window
        minIdleMinutes: 45      // Wait for inactivity
      }
    }
  }
}
```

## Memory Hierarchy

The sleep system manages a four-tier memory hierarchy:

| Tier | Files | Loaded Into Context | Purpose |
|------|-------|---------------------|---------|
| **Short-term** | (SQLite) | No | Daily activities, conversation context |
| **Medium-term** | `memory/memories-medium.md` | Searchable | Reinforced patterns, not yet stable |
| **Long-term** | `MEMORIES-LONG.md` + `memory/memories-long.json` | Yes (bootstrap) | Stable facts, confirmed preferences |
| **Core** | `MEMORIES-CORE.md` + `memory/memories-core.json` | Yes (bootstrap) | Identity-shaping patterns, never deleted |

### Memory Flow

```
Short-term → Medium-term → Long-term → Core
     ↓            ↓             ↓
  (pruned)   (reinforced)   (promoted)
```

- **Short-term**: Raw conversation chunks in SQLite, pruned after `maxAgeHours` (default: 7 days)
- **Medium-term**: Extracted during sleep, written to `memory/memories-medium.md` for search indexing
- **Long-term**: Promoted from medium-term after 3+ reinforcements at 0.7+ confidence
- **Core**: Identity patterns extracted from long-term (never deleted)

### Workspace Memory Files

After each sleep cycle, memory files are synced to your workspace:

```
workspace/
├── MEMORIES-CORE.md          ← Clean list, loaded into every conversation
├── MEMORIES-LONG.md          ← Clean list, loaded into every conversation  
├── MEMORY.md                 ← Your notes (optional, also loaded)
└── memory/
    ├── memories-core.json    ← Full metadata for sleep processing
    ├── memories-long.json    ← Full metadata for sleep processing
    └── memories-medium.md    ← Indexed for memory_search tool
```

**Markdown files** (`MEMORIES-*.md`) are clean, minimal lists designed for context:
- One line per memory with a brief "why" label
- No metadata, timestamps, or confidence scores
- Human-readable and easy to review

**JSON files** (`memories-*.json`) store full metadata:
- IDs, timestamps, confidence, reinforcement counts
- Used by sleep processing for promotion decisions
- Not loaded into conversation context

> **Tip**: Reference `MEMORIES-CORE.md` and `MEMORIES-LONG.md` from your `MEMORY.md` if you want a unified view:
> ```markdown
> ## Persistent Memories
> See [Core Memories](MEMORIES-CORE.md) and [Long-term Memories](MEMORIES-LONG.md).
> ```

## Configuration Reference

### Top-level Settings

```json5
{
  agents: {
    defaults: {
      sleep: {
        enabled: true,           // Enable sleep system (default: false)
        window: "03:00-06:00",   // Sleep window in local time
        minIdleMinutes: 45,      // Minimum idle time before sleep
        allowInterrupt: true,    // Allow user activity to interrupt
        reportLevel: "summary",  // "summary" or "full"
        timezone: "user"         // "user", "local", or IANA TZ id
      }
    }
  }
}
```

### Shallow Sleep (Maintenance)

```json5
{
  agents: {
    defaults: {
      sleep: {
        shallow: {
          enabled: true,
          tasks: {
            configValidation: true,    // Validate config file
            credentialsCheck: true,    // Check token expiry
            integrationProbe: true,    // Probe channel connectivity
            memoryIntegrity: true      // Check memory store health
          },
          updates: {
            enabled: true,
            checkOpenclaw: true,       // Check for OpenClaw updates
            checkDependencies: true,   // Check npm dependencies
            checkTools: true,          // Check tool versions
            autoUpdate: false          // Never auto-update (safety)
          },
          security: {
            enabled: true,
            npmAudit: true,            // Run npm audit
            credentialScan: true,      // Scan for leaked credentials
            advisoryCheck: true,       // Check security advisories
            tlsCheck: true             // Verify TLS certificates
          },
          radar: {
            enabled: true,
            newModels: true,           // Track new AI models
            protocolUpdates: true,     // Track protocol changes
            breakingChanges: true,     // Track breaking changes
            sources: []                // Additional RSS/feed sources
          }
        }
      }
    }
  }
}
```

### Deep Sleep (Memory Consolidation)

```json5
{
  agents: {
    defaults: {
      sleep: {
        deep: {
          enabled: true,
          memoryPruning: {
            enabled: true,
            maxAgeHours: 168,          // 7 days
            decayFactor: 0.1           // Decay rate for relevance
          },
          memoryCompaction: {
            enabled: true,
            minChunks: 100             // Min chunks before compaction
          },
          memoryPromotion: {
            enabled: true,
            minReinforcementsForLongTerm: 3,  // Reinforcements needed
            minConfidenceForLongTerm: 0.7     // Confidence threshold
          },
          coreMemory: {
            enabled: true,
            minRecurrence: 3,          // Pattern recurrence threshold
            minConfidence: 0.7         // Confidence for core promotion
          },
          llmReflection: {
            enabled: true,             // Enable LLM-based memory evaluation
            provider: "anthropic",     // LLM provider
            model: "claude-opus-4-5",  // Model (Opus for quality reasoning)
            batchSize: 20,             // Memories per LLM call
            timeoutMs: 60000,          // 60s timeout per call
            pruneConfidenceThreshold: 0.7,   // Confidence to prune
            promoteRelevanceThreshold: 0.5   // Relevance for promotion
          }
        }
      }
    }
  }
}
```

### LLM-Enhanced Memory Operations

When `llmReflection.enabled` is true, deep sleep uses AI to make smarter memory decisions:

1. **Identity-Aware Pruning**: Evaluates memories through the lens of SOUL.md and IDENTITY.md
2. **Relevance-Based Promotion**: Scores memories by alignment with agent identity
3. **Core Memory Synthesis**: Identifies patterns that define the agent's character

The LLM receives full context including:
- SOUL.md (agent personality and values)
- IDENTITY.md (structured identity metadata)
- Existing core memories (foundational patterns)
- Existing long-term memories (stable facts)
- Medium-term memories (searchable context)

#### Workspace Memory Files

LLM-enhanced operations store memories in the workspace:

| File | Purpose |
|------|---------|
| `MEMORIES-CORE.md` | Core memories (identity-shaping, always loaded) |
| `MEMORIES-LONG.md` | Long-term memories (stable facts, always loaded) |

These files are version-controlled and portable with your agent.

## Sleep Phases

### Shallow Sleep Phase

Runs first, fast and interruptible. Performs system health checks:

1. **Config Validation**: Verifies configuration file integrity
2. **Credentials Check**: Detects expiring tokens and auth issues
3. **Integration Probe**: Tests channel connectivity
4. **Memory Integrity**: Runs SQLite integrity checks on memory stores
5. **Update Check**: Detects available updates for OpenClaw and dependencies
6. **Security Scan**: Runs npm audit, checks for credential leaks
7. **Development Radar**: Tracks new AI models and protocol changes

If any **critical** task fails, deep sleep is aborted.

### Deep Sleep Phase

Runs second, heavier operations with atomic steps:

1. **Prune**: Remove stale short-term chunks older than `maxAgeHours`
2. **Compact**: Consolidate similar chunks to reduce volume
3. **Medium-term Processing**: Extract patterns from short-term, reinforce existing
4. **Long-term Promotion**: Promote reinforced medium-term memories
5. **Core Memory Extraction**: Identify identity-shaping patterns
6. **LLM Reflection** (optional): Use AI to evaluate memories through identity lens

## Sleep Reports

Each sleep cycle generates a report at `~/.openclaw/sleep-reports/`:

```markdown
# Sleep Cycle Report - 2026-01-31

**Agent:** default
**Status:** completed
**Duration:** 2m 34s

## Shallow Sleep
- **Tasks:** 7 passed, 0 failed, 0 skipped
- **Duration:** 12.3s

## Deep Sleep
- **Short-term memories before:** 12,483
- **Short-term memories after:** 4,102
- **Pruned:** 3,200 chunks
- **Compacted:** 5,181 chunks
- **Medium-term memories:** 24 new, 156 reinforced
- **Promoted to long-term:** 8
- **Core memories:** 2 created, 5 reinforced
- **Duration:** 2m 21s
```

## Scheduling Behavior

### Default Behavior
- Window: 03:00-06:00 local time
- Requires 45 minutes of inactivity
- Checks eligibility every heartbeat tick

### Interruption
- **Shallow sleep**: Pauses immediately on user activity
- **Deep sleep**: Completes current atomic step, then stops

### Manual Trigger

Trigger sleep immediately (bypasses window/idle checks):

```bash
# Not yet implemented - future CLI command
# openclaw sleep now
```

## Memory File Locations

Memory files are stored per-agent under `~/.openclaw/agents/<agentId>/agent/`:

| File | Purpose |
|------|---------|
| `memory-index.sqlite` | Short-term chunks and embeddings |
| `medium-term-memories.json` | Reinforced patterns |
| `long-term-memories.json` | Stable memories (auto-loaded) |
| `core-memories.json` | Identity patterns (always loaded) |

## Extreme Events

Some events skip the normal promotion flow:

- Messages containing "extremely important", "never forget", "always remember"
- Critical deadlines or emergencies
- Major decisions or life changes

These are promoted directly to long-term or core memory.

## Best Practices

1. **Keep long-term small**: Target 20-50 entries for fast context loading
2. **Let medium-term grow**: It's searched, not loaded, so size matters less
3. **Trust the reinforcement**: Don't manually promote; let patterns emerge
4. **Review core memories**: Use `openclaw memory core list` to see identity patterns
5. **Monitor reports**: Check `~/.openclaw/sleep-reports/` for health insights

## Troubleshooting

### Sleep not running

Check eligibility:
```bash
openclaw status --deep  # Shows sleep status when implemented
```

Common issues:
- User activity detected within `minIdleMinutes`
- Outside configured sleep window
- System under load or busy queue

### Memory not being pruned

- Check `deep.memoryPruning.enabled`
- Verify `maxAgeHours` isn't too high
- Look for errors in sleep reports

### Credentials expiring

The shallow sleep phase detects expiring tokens. Check the sleep report for warnings:
```
⚠ Slack token expires in 14 days
```

## Related Documentation

- [Memory](/concepts/memory) - Memory files and vector search
- [Heartbeat](/gateway/heartbeat) - Periodic agent turns
- [Compaction](/concepts/compaction) - Context window management
- [Sessions](/concepts/sessions) - Session lifecycle
