import {afterAll, expect, test} from 'bun:test';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

const requests = [];
const api = Bun.serve({port: 0, fetch: async (req) => {
  if (new URL(req.url).pathname !== '/api/puffa/render_shot') return new Response('Unexpected route', {status: 404});
  requests.push(await req.json());
  return Response.json({jobId: 'test-job', state: 'running'});
}});
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [new URL('../server.mjs', import.meta.url).pathname],
  env: {PUFFA_KEY: 'test-only', PUFFA_SERVICE_KEY: 'test-only', PUFFA_API_URL: api.url.origin},
  stderr: 'pipe',
});
const client = new Client({name: 'reference-video-test', version: '1.0.0'});
await client.connect(transport);
afterAll(async () => {await client.close(); api.stop(true);});

test('MCP advertises video references and forwards original source URLs in order', async () => {
  const {tools} = await client.listTools();
  const schema = tools.find(tool => tool.name === 'render_shot').inputSchema;
  expect(schema.properties.referenceVideos.maxItems).toBe(3);
  const input = {prompt: 'Restyle staff in the original footage', referenceVideos: [{url: 'https://example.com/press.mp4'}, {url: 'https://example.com/pack.mov'}], generateAudio: false};
  const result = await client.callTool({name: 'render_shot', arguments: input});
  expect(result.isError).not.toBe(true);
  expect(requests).toEqual([input]);
});

test('MCP rejects invalid or conflicting references before reaching the backend', async () => {
  const before = requests.length;
  for (const input of [
    {referenceVideos: [{url: 'file:///tmp/source.mp4'}]},
    {referenceVideos: [{url: 'https://example.com/press.mp4'}], firstFrame: {url: 'https://example.com/frame.png'}},
    {referenceVideos: Array.from({length: 4}, () => ({url: 'https://example.com/press.mp4'}))},
  ]) {
    const result = await client.callTool({name: 'render_shot', arguments: {prompt: 'Edit', ...input}});
    expect(result.isError).toBe(true);
  }
  expect(requests.length).toBe(before);
});
