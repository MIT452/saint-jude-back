type SpeechResponse = {
  transcript: string;
  audio?: string;
  provider: 'openai' | 'unsupported';
};

export async function transcribeSpeech(audio: string, mimeType: string): Promise<SpeechResponse> {
  const endpoint = process.env.OPENAI_API_URL ?? 'https://api.openai.com/v1';
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY requis pour la transcription vocale');

  const form = new FormData();
  const blob = new Blob([Uint8Array.from(Buffer.from(audio, 'base64'))], { type: mimeType });
  form.append('file', blob, 'audio.webm');
  form.append('model', process.env.OPENAI_SPEECH_MODEL ?? 'whisper-1');
  const response = await fetch(`${endpoint}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!response.ok) throw new Error(`Transcription OpenAI failed: ${response.status}`);
  const data = await response.json() as { text: string };
  return { transcript: data.text, provider: 'openai' };
}

export async function synthesizeSpeech(text: string): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY requis pour la synthèse vocale');
  const baseUrl = (process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/$/, '');
  const response = await fetch(`${baseUrl}/audio/speech`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: process.env.OPENAI_TTS_MODEL ?? 'gpt-4o-mini-tts', voice: process.env.OPENAI_TTS_VOICE ?? 'alloy', input: text }),
  });
  if (!response.ok) throw new Error(`Synthèse OpenAI failed: ${response.status}`);
  return Buffer.from(await response.arrayBuffer()).toString('base64');
}
