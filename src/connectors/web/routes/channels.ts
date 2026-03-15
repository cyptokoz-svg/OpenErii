import { Hono } from 'hono'
import { SessionStore } from '../../../core/session.js'
import { readWebSubchannels, writeWebSubchannels } from '../../../core/config.js'
import type { WebChannel } from '../../../core/types.js'
import type { SSEClient } from './chat.js'

interface ChannelsDeps {
  sessions: Map<string, SessionStore>
  sseByChannel: Map<string, Map<string, SSEClient>>
}

/** Channels CRUD: GET /, POST /, PUT /:id, DELETE /:id */
export function createChannelsRoutes({ sessions, sseByChannel }: ChannelsDeps) {
  const app = new Hono()

  /** GET / — list all channels (default first, then sub-channels) */
  app.get('/', async (c) => {
    const subChannels = await readWebSubchannels()
    const channels = [
      { id: 'default', label: 'Erii' },
      ...subChannels,
    ]
    return c.json({ channels })
  })

  /** POST / — create a new sub-channel */
  app.post('/', async (c) => {
    const body = await c.req.json() as {
      id?: string
      label?: string
      systemPrompt?: string
      provider?: string
      vercelAiSdk?: { provider: string; model: string; baseUrl?: string; apiKey?: string }
      agentSdk?: { model?: string; apiKey?: string; baseUrl?: string }
      disabledTools?: string[]
    }

    if (!body.id || !/^[a-z0-9-_]+$/.test(body.id)) {
      return c.json({ error: 'id must be lowercase alphanumeric with hyphens/underscores' }, 400)
    }
    if (body.id === 'default') {
      return c.json({ error: 'cannot use reserved id "default"' }, 400)
    }
    if (!body.label?.trim()) {
      return c.json({ error: 'label is required' }, 400)
    }

    const existing = await readWebSubchannels()
    if (existing.find((ch) => ch.id === body.id)) {
      return c.json({ error: 'channel id already exists' }, 409)
    }

    const newChannel: WebChannel = {
      id: body.id,
      label: body.label.trim(),
      ...(body.systemPrompt ? { systemPrompt: body.systemPrompt } : {}),
      ...(body.provider === 'claude-code' || body.provider === 'vercel-ai-sdk' || body.provider === 'agent-sdk'
        ? { provider: body.provider }
        : {}),
      ...(body.vercelAiSdk?.provider && body.vercelAiSdk?.model
        ? { vercelAiSdk: body.vercelAiSdk }
        : {}),
      ...(body.agentSdk ? { agentSdk: body.agentSdk } : {}),
      ...(body.disabledTools?.length ? { disabledTools: body.disabledTools } : {}),
    }

    await writeWebSubchannels([...existing, newChannel])

    // Initialize session and SSE map for the new channel
    const session = new SessionStore(`web/${body.id}`)
    await session.restore()
    sessions.set(body.id, session)
    sseByChannel.set(body.id, new Map())

    return c.json({ channel: newChannel }, 201)
  })

  /** PUT /:id — update a sub-channel */
  app.put('/:id', async (c) => {
    const id = c.req.param('id')
    if (id === 'default') return c.json({ error: 'cannot modify default channel' }, 400)

    const body = await c.req.json() as {
      label?: string
      systemPrompt?: string
      provider?: string
      vercelAiSdk?: { provider: string; model: string; baseUrl?: string; apiKey?: string } | null
      agentSdk?: { model?: string; apiKey?: string; baseUrl?: string } | null
      disabledTools?: string[]
    }

    const existing = await readWebSubchannels()
    const idx = existing.findIndex((ch) => ch.id === id)
    if (idx === -1) return c.json({ error: 'channel not found' }, 404)

    const updated: WebChannel = {
      ...existing[idx],
      ...(body.label !== undefined ? { label: body.label } : {}),
      ...(body.systemPrompt !== undefined ? { systemPrompt: body.systemPrompt || undefined } : {}),
      ...(body.provider === 'claude-code' || body.provider === 'vercel-ai-sdk' || body.provider === 'agent-sdk'
        ? { provider: body.provider }
        : body.provider === null || body.provider === ''
          ? { provider: undefined }
          : {}),
      ...(body.vercelAiSdk !== undefined
        ? { vercelAiSdk: body.vercelAiSdk?.provider && body.vercelAiSdk?.model ? body.vercelAiSdk : undefined }
        : {}),
      ...(body.agentSdk !== undefined
        ? { agentSdk: body.agentSdk ?? undefined }
        : {}),
      ...(body.disabledTools !== undefined ? { disabledTools: body.disabledTools?.length ? body.disabledTools : undefined } : {}),
    }
    existing[idx] = updated
    await writeWebSubchannels(existing)

    return c.json({ channel: updated })
  })

  /** DELETE /:id — delete a sub-channel */
  app.delete('/:id', async (c) => {
    const id = c.req.param('id')
    if (id === 'default') return c.json({ error: 'cannot delete default channel' }, 400)
    if (id.startsWith('atlas-')) return c.json({ error: 'atlas department channels are system-managed — disable the department in Atlas config to remove' }, 400)

    const existing = await readWebSubchannels()
    if (!existing.find((ch) => ch.id === id)) return c.json({ error: 'channel not found' }, 404)

    await writeWebSubchannels(existing.filter((ch) => ch.id !== id))

    // Clean up in-memory state
    sessions.delete(id)
    sseByChannel.delete(id)

    return c.json({ success: true })
  })

  return app
}
