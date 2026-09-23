const TELEGRAM_API_ORIGIN = 'https://api.telegram.org'
const TELEGRAM_TEXT_LIMIT = 4096
const DEFAULT_PREVIEW_CHARS = 3000
const DEFAULT_TIMEOUT_MS = 10_000
const ASK_USER_TOOL = 'ask_user_question'

/** Cordis plugin name. */
const name = 'telegram-notifier'

/** Runtime services used by the notifier. */
const inject = ['credentials', 'sessionTitle']


function assertCredentialRef(name, value) {
  if (typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)) {
    throw new Error(`telegram-notifier: ${name} must be an environment-variable-shaped credential reference`)
  }
}

function assertConfig(config) {
  assertCredentialRef('tokenEnv', config.tokenEnv)
  assertCredentialRef('chatIdEnv', config.chatIdEnv)
  if (config.chatId !== undefined && (typeof config.chatId !== 'string' || config.chatId.trim() === '')) {
    throw new Error('telegram-notifier: chatId must be a non-empty string when supplied')
  }
  if (config.messageThreadId !== undefined && (!Number.isSafeInteger(config.messageThreadId) || config.messageThreadId < 1)) {
    throw new Error('telegram-notifier: messageThreadId must be a positive safe integer')
  }
  if (typeof config.notifyClarifications !== 'boolean' || typeof config.notifyAnswers !== 'boolean' || typeof config.includeAnswerPreview !== 'boolean') {
    throw new Error('telegram-notifier: notification toggles must be booleans')
  }
  if (!Number.isSafeInteger(config.maxPreviewChars) || config.maxPreviewChars < 1 || config.maxPreviewChars > TELEGRAM_TEXT_LIMIT) {
    throw new Error(`telegram-notifier: maxPreviewChars must be an integer from 1 to ${TELEGRAM_TEXT_LIMIT}`)
  }
  if (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 1) {
    throw new Error('telegram-notifier: timeoutMs must be a positive safe integer')
  }
  if (typeof config.apiOrigin !== 'string' || config.apiOrigin.trim() === '') {
    throw new Error('telegram-notifier: apiOrigin must be a non-empty string')
  }

  let url
  try {
    url = new URL(config.apiOrigin)
  } catch (error) {
    throw new Error(`telegram-notifier: apiOrigin must be a valid URL: ${String(error)}`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('telegram-notifier: apiOrigin must use http or https')
  }
}

function parseObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value
}

function parseQuestions(rawArguments) {
  let parsed
  try {
    parsed = JSON.parse(rawArguments)
  } catch {
    return []
  }

  const root = parseObject(parsed)
  if (root === undefined || !Array.isArray(root.questions)) return []

  const questions = []
  for (const candidate of root.questions) {
    const question = parseObject(candidate)
    if (question === undefined || typeof question.question !== 'string') continue
    const text = question.question.trim()
    if (text === '') continue

    const options = []
    if (Array.isArray(question.options)) {
      for (const rawOption of question.options) {
        const option = parseObject(rawOption)
        if (option === undefined || typeof option.label !== 'string') continue
        const label = option.label.trim()
        if (label !== '') options.push(label)
      }
    }

    questions.push({
      question: text,
      ...(typeof question.header === 'string' && question.header.trim() !== ''
        ? { header: question.header.trim() }
        : {}),
      ...(options.length > 0 ? { options } : {}),
    })
  }
  return questions
}

function textFromContent(content) {
  return content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
    .trim()
}

function truncate(text, maxChars) {
  if (text.length <= maxChars) return text
  if (maxChars <= 1) return '…'
  return `${text.slice(0, maxChars - 1)}…`
}

function titleFor(ctx, session) {
  const title = ctx.sessionTitle.get(session)?.title?.trim()
  return title === undefined || title === '' ? undefined : title
}

function formatSessionHeader(icon, label, ctx, session) {
  const title = titleFor(ctx, session)
  return [
    `${icon} ${label}`,
    title === undefined ? undefined : `Session: ${title}`,
    `ID: ${session.id}`,
  ].filter(Boolean)
}

function formatClarification(ctx, session, questions) {
  const lines = formatSessionHeader('❓', 'DeepSeek Harness needs clarification', ctx, session)
  lines.push('')

  for (let index = 0; index < questions.length; index += 1) {
    const item = questions[index]
    const prefix = questions.length === 1 ? '' : `${index + 1}. `
    lines.push(`${prefix}${item.header === undefined ? '' : `${item.header}: `}${item.question}`)
    if (item.options !== undefined) {
      for (const option of item.options) lines.push(`• ${option}`)
    }
    if (index < questions.length - 1) lines.push('')
  }

  return truncate(lines.join('\n'), TELEGRAM_TEXT_LIMIT)
}

function formatAnswer(ctx, session, text, reason, config) {
  const label = reason.kind === 'max-tokens'
    ? 'DeepSeek Harness answered (token limit reached)'
    : 'DeepSeek Harness answered'
  const lines = formatSessionHeader('✅', label, ctx, session)

  if (config.includeAnswerPreview && text !== '') {
    lines.push('', truncate(text, config.maxPreviewChars))
  }

  return truncate(lines.join('\n'), TELEGRAM_TEXT_LIMIT)
}

function answerTextForTurn(state, turn) {
  let latest = ''
  for (const entry of state.assistantMessages) {
    if (entry.turn === turn && entry.text !== '') latest = entry.text
  }
  return latest
}

function makeTelegramUrl(apiOrigin, token) {
  return `${apiOrigin.replace(/\/+$/, '')}/bot${encodeURIComponent(token)}/sendMessage`
}

function credentialRef(value) {
  return value
}

async function sendTelegram(ctx, config, text, signal) {
  const token = await ctx.credentials.resolve(credentialRef(config.tokenEnv))
  if (token === undefined) {
    throw new Error(`credential ${config.tokenEnv} is not configured`)
  }

  let chatId = config.chatId
  if (chatId === undefined) {
    const resolvedChatId = await ctx.credentials.resolve(credentialRef(config.chatIdEnv))
    if (resolvedChatId === undefined) {
      throw new Error(`credential ${config.chatIdEnv} is not configured and chatId was not supplied`)
    }
    chatId = resolvedChatId.value
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => {
    controller.abort(new Error(`telegram request exceeded ${config.timeoutMs}ms`))
  }, config.timeoutMs)
  timeout.unref?.()

  const abortFromLifetime = () => controller.abort(signal.reason)
  if (signal.aborted) abortFromLifetime()
  else signal.addEventListener('abort', abortFromLifetime, { once: true })

  try {
    const body = {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
      ...(config.messageThreadId === undefined ? {} : { message_thread_id: config.messageThreadId }),
    }
    const response = await fetch(makeTelegramUrl(config.apiOrigin, token.value), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })

    const responseText = await response.text()
    let payload
    try {
      payload = responseText === '' ? undefined : JSON.parse(responseText)
    } catch {
      payload = undefined
    }

    if (!response.ok || payload?.ok === false) {
      const description = typeof payload?.description === 'string'
        ? payload.description
        : `${response.status} ${response.statusText}`.trim()
      throw new Error(description || 'Telegram API rejected the request')
    }
  } finally {
    clearTimeout(timeout)
    signal.removeEventListener('abort', abortFromLifetime)
  }
}

function apply(ctx, suppliedConfig) {
  const config = {
    tokenEnv: 'TELEGRAM_BOT_TOKEN',
    chatIdEnv: 'TELEGRAM_CHAT_ID',
    apiOrigin: TELEGRAM_API_ORIGIN,
    notifyClarifications: true,
    notifyAnswers: true,
    includeAnswerPreview: true,
    maxPreviewChars: DEFAULT_PREVIEW_CHARS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    ...suppliedConfig,
  }
  assertConfig(config)

  const lifetime = new AbortController()
  const pending = new Set()
  const states = new WeakMap()
  let warnedMissingToken = false
  let warnedMissingChatId = false

  const stateFor = (session) => {
    let state = states.get(session)
    if (state === undefined) {
      state = {
        calls: new Map(),
        assistantMessages: [],
      }
      states.set(session, state)
    }
    return state
  }

  const notify = (text) => {
    if (lifetime.signal.aborted) return
    const work = sendTelegram(ctx, config, text, lifetime.signal)
      .then(() => {
        warnedMissingToken = false
        warnedMissingChatId = false
      })
      .catch((error) => {
        if (lifetime.signal.aborted) return
        const message = String(error)
        if (message.includes(`credential ${config.tokenEnv} is not configured`)) {
          if (warnedMissingToken) return
          warnedMissingToken = true
        } else if (message.includes(`credential ${config.chatIdEnv} is not configured`)) {
          if (warnedMissingChatId) return
          warnedMissingChatId = true
        }
        ctx.logger.warn(`telegram-notifier: notification failed: ${message}`)
      })
      .finally(() => pending.delete(work))
    pending.add(work)
  }

  ctx.on('session/event', (session, event) => {
    const state = stateFor(session)

    switch (event.type) {
      case 'tool/call': {
        const call = {
          name: event.data.name,
          arguments: event.data.arguments,
        }
        state.calls.set(String(event.data.callId), call)
        if (!config.notifyClarifications || call.name !== ASK_USER_TOOL) return
        const questions = parseQuestions(call.arguments)
        if (questions.length === 0) {
          ctx.logger.warn(`telegram-notifier: ignored malformed ${ASK_USER_TOOL} arguments in session ${session.id}`)
          return
        }
        notify(formatClarification(ctx, session, questions))
        return
      }
      case 'tool/result':
        state.calls.delete(String(event.data.message.content[0]?.toolCallId ?? ''))
        return
      case 'assistant/message': {
        const text = textFromContent(event.data.message.content)
        state.assistantMessages.push({ turn: event.data.turn, text })
        return
      }
      case 'turn/end': {
        if (!config.notifyAnswers) return
        const { turn, reason } = event.data
        if (reason.kind !== 'completed' && reason.kind !== 'max-tokens') return
        const text = answerTextForTurn(state, turn)
        if (text === '') return
        notify(formatAnswer(ctx, session, text, reason, config))
        state.assistantMessages = state.assistantMessages.filter((entry) => entry.turn > turn)
        return
      }
      default:
        return
    }
  })

  ctx.on('session/disposed', (session) => {
    states.delete(session)
  })

  ctx.effect(() => async () => {
    lifetime.abort(new Error('telegram-notifier disposed'))
    await Promise.allSettled([...pending])
  }, 'telegram-notifier: drain pending notifications')
}

export {
  apply,
  formatAnswer,
  formatClarification,
  inject,
  name,
  parseQuestions,
  textFromContent,
  truncate,
}
