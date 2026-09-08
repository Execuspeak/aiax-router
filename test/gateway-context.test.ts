import { describe, expect, it } from 'vitest';
import { conversationTask, lastUserText } from '../src/gateway/serve.js';

describe('gateway conversation projection', () => {
  it('preserves system and prior turns while identifying the last user text', () => {
    const messages = [
      { role: 'system', content: 'Follow the caller policy.' },
      { role: 'user', content: 'First question.' },
      { role: 'assistant', content: 'First answer.' },
      { role: 'user', content: [{ type: 'text', text: 'Final question.' }] },
    ];
    expect(lastUserText(messages)).toBe('Final question.');
    expect(conversationTask(messages)).toBe(
      '<system>\nFollow the caller policy.\n</system>\n\n' +
      '<user>\nFirst question.\n</user>\n\n' +
      '<assistant>\nFirst answer.\n</assistant>\n\n' +
      '<user>\nFinal question.\n</user>',
    );
  });
});
