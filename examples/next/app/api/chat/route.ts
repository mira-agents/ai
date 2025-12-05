import type { MyUIMessage } from '@/util/chat-schema';
import { readChat, saveChat } from '@util/chat-store';
import { convertToModelMessages, generateId, streamText } from 'ai';
import { after } from 'next/server';
import { createResumableStreamContext } from 'resumable-stream';
import throttle from 'throttleit';

/**
 * chat API 路由
 * 
 * POST 核心步骤（含序号标记）：
 * 1. 解析请求体，获取 message、id、trigger、messageId。
 * 2. 获取指定 id 的 chat 历史消息。
 * 3. 根据 trigger（submit-message or regenerate-message）处理 messages 数组。
 * 4. 更新 chat（保存用户消息）。
 * 5. 准备 AbortController 控制生成流。
 * 6. 使用 streamText 发送请求并处理流，开启节流监听取消。
 * 7. 返回 UI message stream 响应，带上相关回调。
 */
export async function POST(req: Request) {
  // 1. 解析请求体，获取参数
  const {
    message,
    id,
    trigger,
    messageId,
  }: {
    message: MyUIMessage | undefined;
    id: string;
    trigger: 'submit-message' | 'regenerate-message';
    messageId: string | undefined;
  } = await req.json();

  // 2. 获取对应 chat 和消息历史
  const chat = await readChat(id);
  let messages: MyUIMessage[] = chat.messages;

  // 3. 操作消息内容，根据 trigger（主要分支）
  if (trigger === 'submit-message') {
    // submit-message：插入最新的用户消息
    if (messageId != null) {
      // 找到该 messageId 所在索引，裁剪
      const messageIndex = messages.findIndex(m => m.id === messageId);

      if (messageIndex === -1) {
        throw new Error(`message ${messageId} not found`);
      }

      // 截取到当前 messageIndex 之前，并追加新消息
      messages = messages.slice(0, messageIndex);
      messages.push(message!);
    } else {
      messages = [...messages, message!];
    }
  } else if (trigger === 'regenerate-message') {
    // regenerate-message：截取消息队列，为重新生成做准备
    const messageIndex =
      messageId == null
        ? messages.length - 1
        : messages.findIndex(message => message.id === messageId);

    if (messageIndex === -1) {
      throw new Error(`message ${messageId} not found`);
    }

    // 如果要回到 assistant 消息，则只保留之前的部分
    messages = messages.slice(
      0,
      messages[messageIndex].role === 'assistant'
        ? messageIndex
        : messageIndex + 1,
    );
  }

  // 4. 存储消息内容（持久化当前会话状态）
  saveChat({ id, messages, activeStreamId: null });

  // 5. 构建 abort 信号（用于后续取消请求）
  const userStopSignal = new AbortController();

  // 6. 生成文本流，配置取消检测和回调
  const result = streamText({
    model: 'openai/gpt-5-mini',
    messages: convertToModelMessages(messages),
    // 用于取消请求的 AbortSignal，当调用 userStopSignal.abort() 时会停止生成
    abortSignal: userStopSignal.signal,
    // onChunk: 每次收到数据块（text-delta、tool-call 等）时调用
    // 使用 throttle 节流，限制为最多每 1000ms 执行一次，避免频繁查询数据库
    // 检测逻辑：从数据库读取 chat 的 canceledAt 字段，如果用户已取消（有值），则主动调用 abort() 停止生成
    onChunk: throttle(async () => {
      const { canceledAt } = await readChat(id);
      if (canceledAt) {
        userStopSignal.abort();
      }
    }, 1000),
    // 当请求被取消时（通过 abortSignal 或 onChunk 检测到取消）触发的回调
    onAbort: () => {
      console.log('aborted');
    },
  });

  // 7. 返回消息流响应，并注入各类回调
  return result.toUIMessageStreamResponse({
    originalMessages: messages,
    generateMessageId: generateId,
    // 消息元数据（用于 UI 展示消息创建时间等）
    messageMetadata: ({ part }) => {
      if (part.type === 'start') {
        return { createdAt: Date.now() };
      }
    },
    // 生成完全流后，保存最新消息历史
    onFinish: ({ messages }) => {
      saveChat({ id, messages, activeStreamId: null });
    },
    // SSE 流追加使用 resumable-stream 进行持久化
    async consumeSseStream({ stream }) {
      const streamId = generateId();
      // 创建新的可恢复流上下文
      const streamContext = createResumableStreamContext({ waitUntil: after });
      await streamContext.createNewResumableStream(streamId, () => stream);
      // 更新 chat 的 activeStreamId
      saveChat({ id, activeStreamId: streamId });
    },
  });
}
