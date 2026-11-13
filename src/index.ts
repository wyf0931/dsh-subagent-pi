/**
 * Named one-shot subagent provider backed by the local Pi CLI in RPC mode.
 * Every delegation spawns its own `pi --mode rpc` child and disposes it when
 * the turn settles; no Pi code runs inside this process.
 *
 * @module dsh-subagent-pi
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  NO_START_CAPABILITIES,
  type SubagentProvider,
} from '@deepseek-ai/dsh-subagent'
import { parseDuration } from './duration.ts'
import { PiSubagentFailure } from './failures.ts'
import { startPiRun, type PiRunSpec } from './run.ts'

export const name = 'subagent-pi'
export const inject = ['subagents']

const DEFAULT_PROVIDER_NAME = 'pi'

/** Thinking levels Pi accepts; an unknown word would be clamped silently. */
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/** Configuration of one Pi subagent provider instance. */
export interface Config {
  /** Name registered on the subagent service (default pi). */
  providerName?: string
  /** Pi CLI executable name or absolute path (default pi, resolved from PATH). */
  piPath?: string
  /** Pi global config home; omission uses `PI_CODING_AGENT_DIR` or Pi's default. */
  agentDir?: string
  /** Directory for Pi session storage and lookup; omission uses Pi's default. */
  sessionDir?: string
  /** Trust project-local files for this run, because no human answers the dialog. */
  approve?: boolean
  /** Model spelled `provider/model`, or a Pi pattern; omission keeps Pi's selection. */
  model?: string
  /** Thinking level; omission keeps Pi's selection. */
  thinking?: string
  /** Pi tool names excluded from every delegated session. */
  excludeTools?: string[]
  /** Deadline such as `30m` or `1h` after the prompt is sent; omission means no deadline. */
  timeout?: string
}

export const Config = z.object({
  providerName: z.string().min(1).default(DEFAULT_PROVIDER_NAME),
  piPath: z.string().min(1).default('pi'),
  agentDir: z.string().min(1),
  sessionDir: z.string().min(1),
  approve: z.boolean().default(true),
  // Volatile fields appear in the Plugins page form and apply to the next
  // delegation without remounting this provider.
  model: z.string().min(1).volatile(),
  thinking: z.string().min(1).volatile(),
  excludeTools: z.array(z.string().min(1)).default([]).volatile(),
  timeout: z.string().min(1).volatile(),
})

/** Resolved configuration: volatile fields are live references into the profile layer. */
export type ResolvedConfig = ReturnType<typeof Config>

/**
 * Read the live deployment settings for one delegation.
 * @param config - the plugin config carrying volatile references.
 * @returns the resolved one-shot run settings.
 * @throws PiSubagentFailure when a configured value Pi would silently clamp.
 */
function readSpec(config: ResolvedConfig): PiRunSpec {
  const thinking = config.thinking?.get()
  if (thinking !== undefined && !(THINKING_LEVELS as readonly string[]).includes(thinking)) {
    throw new PiSubagentFailure('startup', 'misconfigured', {
      cause: new Error(`Pi has no thinking level ${thinking} (levels: ${THINKING_LEVELS.join(', ')})`),
    })
  }
  const timeout = config.timeout?.get()
  const model = config.model?.get()
  return {
    piPath: config.piPath ?? 'pi',
    approve: config.approve ?? true,
    excludeTools: config.excludeTools?.get() ?? [],
    ...(config.agentDir === undefined ? {} : { agentDir: config.agentDir }),
    ...(config.sessionDir === undefined ? {} : { sessionDir: config.sessionDir }),
    ...(thinking === undefined ? {} : { thinking }),
    ...(timeout === undefined ? {} : { timeoutMs: parseDuration(timeout) }),
    ...(model === undefined ? {} : { model }),
  }
}

/**
 * Register one Pi RPC provider with the shared subagent service.
 * @param ctx - context carrying the shared subagent service.
 * @param config - provider name, CLI path, Pi home and deployment settings.
 */
export function apply(ctx: Context, config: ResolvedConfig): void {
  const providerName = config.providerName ?? DEFAULT_PROVIDER_NAME
  const spec = (): PiRunSpec => ({
    ...readSpec(config),
    onError: (error) => {
      ctx.logger.warn('subagent-pi "%s": %s', providerName, error.message)
    },
  })
  const provider: SubagentProvider = {
    name: providerName,
    capabilities: NO_START_CAPABILITIES,
    inheritsParentContext: false,
    start: request => startPiRun(request, spec()),
  }
  ctx.subagents.registerProvider(provider)
}
