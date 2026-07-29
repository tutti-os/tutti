# Model Tier Reference

This routing prior combines the packaged OpenSquilla provider ladders at
revision `d8652b72` (2026-07-28), Tutti live-catalog evidence, and current
vendor descriptions. It is neither a benchmark result nor an availability
catalog.

Always intersect this table with the exact models returned by the current
target's `agent composer-options` command. Never copy an unavailable id from
this file into a plan.

## Provider ladders

| Provider        | C0                                   | C1                                         | C2                                     | C3                                                                        | Vision route                 |
| --------------- | ------------------------------------ | ------------------------------------------ | -------------------------------------- | ------------------------------------------------------------------------- | ---------------------------- |
| OpenAI          | `gpt-5.6-luna` low effort            | `gpt-5.6-luna` medium effort               | `gpt-5.6-terra` medium/high effort     | `gpt-5.6-sol` high/max/ultra; Sol Pro when advertised                     | Use current catalog evidence |
| OpenAI legacy   | `gpt-5.4-nano`                       | `gpt-5.4-mini`                             | `gpt-5.5` medium effort                | `gpt-5.5` high effort                                                     | Use current catalog evidence |
| Cursor          | `composer-2.5` fast, overqualified   | `composer-2.5` fast                        | `composer-2.5` standard or fast        | `composer-2.5` for long-horizon coding only                               | Current catalog evidence     |
| Cursor Grok     | `grok-4.5` low effort, overqualified | `grok-4.5` low effort                      | `grok-4.5` medium effort               | `grok-4.5` high effort                                                    | Current catalog evidence     |
| SpaceXAI        | `grok-4.5` low effort, overqualified | `grok-4.5` low effort                      | `grok-4.5` medium effort               | `grok-4.5` high effort                                                    | `grok-4.5`                   |
| OpenRouter      | `deepseek/deepseek-v4-flash`         | `deepseek/deepseek-v4-pro`                 | `z-ai/glm-5.2`                         | `anthropic/claude-opus-4.8`; `moonshotai/kimi-k3` for long-context coding | `moonshotai/kimi-k3`         |
| DashScope       | `qwen3.6-flash`                      | `qwen3.7-plus`                             | `qwen3.7-max`                          | `qwen3.7-max`                                                             | Use current catalog evidence |
| Qwen Token Plan | `qwen3.6-flash`                      | `qwen3.7-plus`                             | `qwen3.7-max`                          | `qwen3.8-max-preview`                                                     | `qwen3.7-plus`               |
| DeepSeek        | `deepseek-v4-flash` no thinking      | `deepseek-v4-flash` low thinking           | `deepseek-v4-pro` medium thinking      | `deepseek-v4-pro` high thinking                                           | Use current catalog evidence |
| Gemini          | `gemini-3.1-flash-lite`              | `gemini-3.5-flash`                         | `gemini-3.1-pro-preview`               | `gemini-3.1-pro-preview` high thinking                                    | Use current catalog evidence |
| Zhipu           | `glm-5-turbo`                        | `glm-5`                                    | `glm-5.1`                              | `glm-5.2`                                                                 | Use current catalog evidence |
| Moonshot        | `kimi-k2.6` low thinking             | `kimi-k2.6` medium thinking                | `kimi-k2.7-code`; `kimi-k3` low effort | `kimi-k3` high/max effort                                                 | `kimi-k3`                    |
| Volcengine      | `doubao-seed-2-0-lite-260215`        | `doubao-seed-2-0-lite-260215` low thinking | `doubao-seed-2-0-pro-260215`           | `doubao-seed-2-0-pro-260215` high thinking                                | Use current catalog evidence |
| BytePlus        | `seed-2-0-lite-260228`               | same model, low thinking                   | same model, medium thinking            | same model, high thinking                                                 | Use current catalog evidence |
| TokenRhythm     | `deepseek-v4-flash`                  | `deepseek-v4-pro`                          | `kimi-k2.7-code`                       | `glm-5.2`; `kimi-k3` for long-context coding                              | `kimi-k3`                    |

## Differentiated route notes

Use these only when the exact route is present in current `composer-options`.
A tier is task-shape-specific: a coding-specialist C3 route is not automatically
the best architecture, research, or final-synthesis route.

| Family or exact route                                        | Prior tier  | Prefer for                                                                | Constraint                                                                |
| ------------------------------------------------------------ | ----------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `gpt-5.6-luna`                                               | C1          | Fast, cost-efficient bounded and everyday coding                          | Use Terra or Sol when task/effect requires C2 or C3                       |
| `gpt-5.6-terra`                                              | C2          | Balanced everyday implementation, debugging, and integration              | Do not prefer it over Sol solely because it is the planner's default      |
| `gpt-5.6-sol`, `gpt-5.6-sol-pro`                             | C3          | Hard implementation, architecture, deep review, and final synthesis       | Prefer Sol Pro only when advertised; never synthesize a `-pro` route      |
| `composer-2.5` and `composer-2.5[...]`                       | C2-C3       | Fast hands-on coding and sustained long-running implementation            | Count as C3 only for evidence-backed agentic coding; fast keeps base tier |
| `grok-4.5`, `grok-4.5[...]`, `x-ai/grok-4.5`, `xai/grok-4.5` | C3          | Fast frontier coding, engineering, and tool-heavy agentic work            | Requested-origin entries are not availability evidence                    |
| Kimi K3 family                                               | C2-C3       | Very long context, large repositories, multimodal and long-horizon coding | Low effort is C2; high/max is C3                                          |
| Claude Haiku family                                          | C0-C1       | Bounded, latency-sensitive work                                           | Use current family generation                                             |
| Claude Sonnet family                                         | C2          | Substantial implementation and debugging                                  | Use current family generation                                             |
| Claude Opus family                                           | C3          | Architecture, deep review, and high-stakes synthesis                      | Use current family generation                                             |
| Gemini Flash-Lite / Flash / Pro families                     | C0/C1/C2-C3 | Fast simple / balanced low-latency / strong multimodal work               | Use description and reasoning controls to distinguish Pro's top tier      |

## Route aliases

Classify aliases as one family, but preserve the exact value returned by
`composer-options` in the plan:

- Kimi Open Platform/Codex: `kimi-k3`; Claude-compatible catalogs may return
  `kimi-k3[1m]`.
- OpenAI-compatible plans may namespace GPT routes, for example
  `openai/gpt-5.6-sol-pro`; classify the family but preserve the namespaced id.
- Kimi Code: `k3` and `k3-256k`; the 256K route keeps K3's tier but does not
  satisfy a task that requires more than 256K context.
- OpenRouter: `moonshotai/kimi-k3`.
- Cursor Composer: parameterized values such as
  `composer-2.5[fast=true]`; standard and fast keep the same capability tier.
- Cursor Grok: preserve bare or parameterized `grok-4.5` values exactly; do not
  substitute a Model Plan's namespaced value.

## Family inference

When an exact model is absent from the table:

1. Prefer its current provider description and advertised capabilities.
2. Match a known family only when the family and generation are unambiguous.
3. Treat `nano`, `flash-lite`, and equivalent small variants as C0 priors.
4. Treat `mini`, `flash`, `lite`, and equivalent balanced variants as C1
   priors unless provider evidence states otherwise.
5. Treat `pro`, `max`, `sonnet`, and code-specialized strong variants as C2
   priors.
6. Treat `opus`, frontier, highest-capability, and explicit high-stakes variants
   as C3 priors.
7. Treat `turbo` as a speed signal, not automatically as a lower capability
   tier.
8. Do not give the planning Agent, current provider/model, or a provider default
   any family-inference bonus.
9. Do not infer image support, context size, tool support, or availability from
   the name.

## Refresh anchors

When updating this prior, recheck the current runtime catalog and the vendor
descriptions for [GPT-5.6](https://openai.com/index/gpt-5-6/),
[Composer 2.5](https://cursor.com/changelog/composer-2-5),
[Grok 4.5](https://docs.x.ai/developers/models/grok-4.5), and
[Kimi K3](https://www.kimi.com/help/kimi-api/api-model-selection). Vendor
descriptions inform task fit; they never override live availability evidence.
