# DeepSeek Harness Telegram notifier

A small Cordis plugin that sends a Telegram message when any live DeepSeek Harness agent:

- calls `ask_user_question` for clarification, confirmation, or a choice;
- completes a turn with a visible final text answer.

It listens to the shared `session/event` stream, so it covers the main agent and in-process subagents handled by the same Harness runtime.

## Behavior

- Clarification notifications include the session title/id, question text, and option labels.
- Answer notifications include the session title/id and a configurable answer preview.
- Aborted, blocked, interrupted, and errored turns are not reported as completed answers.
- Notification delivery is fire-and-forget. Telegram failures are logged and never break an agent turn.
- The bot token and, by default, the chat id are resolved through Harness credentials and are not placed in the plugin configuration.

## 1. Create the Telegram bot

1. Open Telegram and message [`@BotFather`](https://t.me/BotFather).
2. Run `/newbot` and copy the bot token.
3. Start a private chat with the new bot and send it one message.
4. Open the following URL, replacing `<TOKEN>`:

   ```text
   https://api.telegram.org/bot<TOKEN>/getUpdates
   ```

5. Copy `message.chat.id` from the JSON result. For a group, add the bot to the group, send a message, and use that group's negative chat id.

## 2. Install the local plugin into the Web profile

Use pnpm 11.18.0 (pinned in `package.json`) for this project's dependencies and scripts. From the project directory, install the locked dependencies:

```bash
pnpm install --frozen-lockfile
```

Commit `pnpm-lock.yaml` when changing dependencies. The local `pnpm-workspace.yaml` keeps this repository independent of any parent pnpm workspace.

From the parent directory that contains `dsh-telegram-notifier`:

```bash
dsh plugin --profile web add ./dsh-telegram-notifier
```

If you run the command while already inside `dsh-telegram-notifier`, use:

```bash
dsh plugin --profile web add "$PWD"
```

## 3. Store credentials

Put the bot token and chat id in the local, Git-ignored `.env.secret` file:

```dotenv
TELEGRAM_BOT_TOKEN=123456789:replace-with-your-token
TELEGRAM_CHAT_ID=123456789
```

Then sync them into DSH:

```bash
pnpm run setup
```

The setup command merges both values into `$DSH_HOME/.credentials.yaml` (normally `~/.dsh/.credentials.yaml`), preserves other credentials already in that file, and restricts both secret files to owner-only access. Run `pnpm run credentials:sync` whenever you change `.env.secret`.

For a fresh clone, create the local file from the tracked template first:

```bash
cp .env.example .env.secret
```

You may alternatively launch DSH with `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in its environment. Environment values have higher precedence than the managed credential file and require a Harness restart when changed.

## 4. Enable the plugin

Add this row to the top-level array in `$DSH_HOME/profiles/web/cordis.patch.yml`:

```yaml
- insert:
    - id: telegram-notifier
      name: dsh-telegram-notifier
      config:
        tokenEnv: TELEGRAM_BOT_TOKEN
        chatIdEnv: TELEGRAM_CHAT_ID
        notifyClarifications: true
        notifyAnswers: true
        includeAnswerPreview: true
        maxPreviewChars: 3000
        timeoutMs: 10000
```

The Web profile uses live patch reload, so the row should load into the running GUI after the profile dependency has been installed. If it does not, restart the existing `dsh web` process; do not start a second server on another port.

You can put a non-secret chat id directly in configuration instead of using a credential:

```yaml
config:
  tokenEnv: TELEGRAM_BOT_TOKEN
  chatId: "123456789"
```

For a Telegram forum topic, add its integer topic id:

```yaml
config:
  messageThreadId: 42
```

## Configuration

| Field | Default | Meaning |
|---|---:|---|
| `tokenEnv` | `TELEGRAM_BOT_TOKEN` | Harness credential reference containing the bot token. |
| `chatIdEnv` | `TELEGRAM_CHAT_ID` | Harness credential reference containing the target chat id when `chatId` is omitted. |
| `chatId` | omitted | Optional direct target chat id; overrides `chatIdEnv`. Quote negative group ids in YAML. |
| `messageThreadId` | omitted | Optional Telegram forum topic id. |
| `apiOrigin` | `https://api.telegram.org` | Telegram-compatible API origin, useful for testing or a local Bot API server. |
| `notifyClarifications` | `true` | Notify on `ask_user_question` tool calls. |
| `notifyAnswers` | `true` | Notify on successful completed/max-token turns with visible text. |
| `includeAnswerPreview` | `true` | Include the final assistant text in completion notifications. |
| `maxPreviewChars` | `3000` | Maximum answer-preview characters before ellipsis. |
| `timeoutMs` | `10000` | Telegram request timeout in milliseconds. |

## Verify

Run local checks:

```bash
cd dsh-telegram-notifier
pnpm test
pnpm run check
```

After enabling the plugin, ask an agent to perform a task that intentionally needs a choice. You should receive one clarification notification, and after answering in the Harness GUI, one completion notification.

## Notes and limitations

- Notifications are outbound only. Replies in Telegram do not answer `ask_user_question`; answer it in the Harness GUI.
- A clarification alert is emitted when the tool call is durably logged, before the GUI answer arrives.
- Completion uses the last visible assistant text in the completed turn. Tool-only turns without visible assistant text do not generate an answer alert.
- Very long Telegram messages are capped at Telegram's 4096-character limit.
