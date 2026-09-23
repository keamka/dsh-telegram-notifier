import test from 'node:test'
import assert from 'node:assert/strict'

import {
  formatClarification,
  parseQuestions,
  textFromContent,
  truncate,
} from '../lib/index.js'

function contextWithTitle(title) {
  return {
    sessionTitle: {
      get() {
        return title === undefined ? undefined : { title }
      },
    },
  }
}

test('parseQuestions reads headers, questions, and option labels', () => {
  const parsed = parseQuestions(JSON.stringify({
    questions: [
      {
        id: 'mode',
        header: 'Choose Mode',
        question: 'Which mode should I use?',
        options: [
          { label: 'Safe', description: 'Slower' },
          { label: 'Fast' },
        ],
      },
    ],
  }))

  assert.deepEqual(parsed, [{
    header: 'Choose Mode',
    question: 'Which mode should I use?',
    options: ['Safe', 'Fast'],
  }])
})

test('parseQuestions contains malformed arguments', () => {
  assert.deepEqual(parseQuestions('{nope'), [])
  assert.deepEqual(parseQuestions(JSON.stringify({ questions: [] })), [])
  assert.deepEqual(parseQuestions(JSON.stringify({ questions: [{ question: '   ' }] })), [])
})

test('textFromContent keeps only visible text blocks', () => {
  assert.equal(textFromContent([
    { type: 'reasoning', text: 'hidden' },
    { type: 'text', text: 'Hello ' },
    { type: 'tool-call', id: '1', name: 'x', arguments: '{}' },
    { type: 'text', text: 'world' },
  ]), 'Hello world')
})

test('truncate preserves short text and ellipsizes long text', () => {
  assert.equal(truncate('abc', 3), 'abc')
  assert.equal(truncate('abcd', 3), 'ab…')
  assert.equal(truncate('abcd', 1), '…')
})

test('formatClarification includes session identity and choices', () => {
  const text = formatClarification(
    contextWithTitle('Telegram notifier'),
    { id: 'session-123' },
    [{
      header: 'Confirm',
      question: 'Continue?',
      options: ['Yes', 'No'],
    }],
  )

  assert.match(text, /DeepSeek Harness needs clarification/)
  assert.match(text, /Session: Telegram notifier/)
  assert.match(text, /ID: session-123/)
  assert.match(text, /Confirm: Continue\?/)
  assert.match(text, /• Yes/)
  assert.match(text, /• No/)
})
