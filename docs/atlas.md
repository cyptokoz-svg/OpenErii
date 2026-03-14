# Atlas Research Extension

Multi-agent layered research team engine for Open Alice.

## Overview

Atlas adds a configurable multi-department research team to Alice. Each department has independent agents organized in layers (L1→L4), an Obsidian knowledge graph, Darwinian performance tracking, and AutoResearch self-evolution.

## Architecture

```
L1 (Macro)     → 10 agents analyze macro environment concurrently
L2 (Sector)    → 7 agents analyze sector-specific data concurrently
L3 (Strategy)  → 4 agents propose strategies concurrently
L4 (Decision)  → 4 agents run sequentially: CRO → PM → Devil's Advocate → CIO
```

Each layer's output is synthesized (weighted voting) and passed as context to the next layer. The CIO produces the final trading signal.

## Key Features

- **Configuration-driven**: Add new departments with just prompt files + agents.json — zero code required
- **Darwinian weights**: Agents weighted by historical Sharpe ratio / win rate
- **AutoResearch**: Finds worst agent → LLM generates improved prompt → 5-day A/B test → keep/revert
- **Obsidian knowledge graph**: Per-department vaults with `[[wikilinks]]`, BFS traversal, conflict detection, GC
- **Real-time streaming**: Each agent posts analysis content to the research channel as they complete
- **Data freshness**: Price agents always run; news-only agents skip if no new news since last run
- **Sub-channel chat**: Users can chat directly with departments or individual agents

## File Structure

```
src/extension/atlas/
├── types.ts          # All shared type definitions
├── envelope.ts       # Zod schemas, tolerant parsing (direction normalize, conviction clamp)
├── config.ts         # Load atlas.json, department agents.json, prompts
├── synthesizer.ts    # Weighted voting, layer synthesis
├── knowledge.ts      # Obsidian vault: read/write notes, wikilinks, BFS, dedup, GC
├── runner.ts         # Agent execution: prompt → data → LLM → parse → knowledge
├── pipeline.ts       # L1→L2→L3→L4 orchestration with concurrency
├── scorecard.ts      # Signal recording, Sharpe/win rate, Darwinian weight updates
├── autoresearch.ts   # Evolution loop: find worst → improve → A/B test
├── data-bridge.ts    # Connect opentypebb data to agents
├── adapter.ts        # 5 tools for Alice's ToolCenter
├── channels.ts       # Auto-create research sub-channels
├── bootstrap.ts      # Wire everything into Alice's runtime
└── index.ts          # Public API re-exports

data/config/atlas.json           # Global config (enabled, model_tiers, departments)
data/atlas/{dept}/agents.json    # Agent definitions per department
data/atlas/{dept}/prompts/*.md   # Agent prompt files
data/atlas/{dept}/knowledge/     # Obsidian vault directories
```

## Configuration

### atlas.json

```json
{
  "enabled": true,
  "model_tiers": { "default": "haiku", "senior": "sonnet", "lead": "opus" },
  "max_concurrency": 5,
  "departments": [
    {
      "id": "commodity",
      "name": "commodity",
      "enabled": true,
      "layers": ["L1", "L2", "L3", "L4"],
      "agents_config": "agents.json",
      "timeframes": ["15m", "4h", "1d"]
    }
  ]
}
```

### agents.json (per department)

Each agent has:
- `name` / `display_name` — identifier and display label
- `layer` — L1/L2/L3/L4
- `model_tier` — maps to model in atlas.json
- `prompt_file` — markdown prompt in `prompts/` directory
- `knowledge_links` — Obsidian vault paths to read
- `data_sources` — what data to fetch (price/news/macro)
- `chat_enabled` — allow direct user chat via sub-channel
- `enabled` — toggle on/off

## Alice Integration

### Tools

| Tool | Description |
|------|-------------|
| `atlasAnalysis` | Run full L1→L4 analysis, returns signal |
| `atlasScorecard` | View agent Sharpe, win rate, weights |
| `atlasKnowledge` | Search Obsidian knowledge graph |
| `atlasEvolve` | Trigger AutoResearch evolution |
| `atlasDepartments` | List departments and status |

### Communication Flow

1. User asks Alice for analysis
2. Alice calls `atlasAnalysis` tool
3. Each agent posts analysis to **Research channel** as they complete (real-time SSE)
4. Alice receives final CIO report
5. Alice summarizes conclusion in **main channel** and asks user for action
6. No duplicate — research channel shows detail, main channel shows conclusion only

### Sub-channels

Auto-created for each enabled department:
- `atlas-{dept}` — Department research channel (all agent analysis)
- `atlas-{dept}-{agent}` — Per-agent chat (for `chat_enabled` agents)

## i18n

Frontend supports English (default) and Chinese:
- Language packs: `ui/src/i18n/en.ts`, `ui/src/i18n/zh.ts`
- Hook: `useLocale()` returns `{ t, locale, setLocale }`
- Switcher: `<LanguageSwitcher />` in sidebar

## Adding a New Department

1. Create `data/atlas/{dept}/agents.json` with agent definitions
2. Create prompt files in `data/atlas/{dept}/prompts/`
3. Create empty knowledge vault dirs in `data/atlas/{dept}/knowledge/`
4. Add department entry to `data/config/atlas.json`
5. Restart Alice — channels auto-created, tools auto-available

No code changes needed.
