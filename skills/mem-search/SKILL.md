---
name: mem-search
description: Search persistent memory from previous AI IDE sessions. Use when asked about past work, previous implementations, debugging history, or any cross-session context. Follows 3-layer progressive disclosure pattern.
---

# mem-search

Search your persistent memory of tool use and session history.

## When to Use

- User asks "did we solve this before?" or "how did we do X last time?"
- You need context from previous sessions on this project
- Debugging a recurring issue that may have been seen before
- Looking for prior implementations or patterns

## 3-Layer Progressive Disclosure

**ALWAYS follow this order. Never fetch full observations without filtering first.**

### Layer 1: Search (always start here)

Call the `search` MCP tool:
```
search(query="<natural language query>", project="<current project path>", limit=10)
```

This returns a compact index: IDs + snippets + timestamps. ~50-100 tokens per result.

### Layer 2: Timeline (for promising results)

For interesting results, get surrounding context:
```
timeline(anchor_id=<id>, before=3, after=3)
```

This shows what happened before/after the anchor observation. ~200-500 tokens.

### Layer 3: Full Detail (only for confirmed relevant items)

Fetch complete data for filtered IDs:
```
get_observations(ids=[<id1>, <id2>, ...])
```

Only call this for IDs you've confirmed are relevant from layers 1-2.

## Token Budget

- Layer 1 only: ~500 tokens saved vs fetching all
- Layer 1+2: ~2,000 tokens saved
- Layer 1+2+3 (filtered): ~5,000+ tokens saved

## Example Usage

User: "How did we fix the authentication bug last week?"

1. `search(query="authentication bug fix", limit=10)`
2. Find relevant result IDs from snippets
3. `timeline(anchor_id=42, before=2, after=2)` for context
4. `get_observations(ids=[41, 42, 43])` for full detail
5. Report findings to user
