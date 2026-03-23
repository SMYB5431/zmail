import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { Env } from './types';
import {
  createMailbox,
  getMailbox,
  deleteMailbox,
  getEmails,
  getEmail,
  deleteEmail,
  getAttachments,
  getAttachment
} from './database';
import { handleEmail } from './email-handler';
import { generateRandomAddress, } from './utils';

// 创建 Hono 应用
const app = new Hono<{ Bindings: Env }>();

// 添加 CORS 中间件
app.use('/*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'X-Inbound-Email-Secret'],
  maxAge: 86400,
}));

// 健康检查端点
app.get('/', (c) => {
  return c.json({ status: 'ok', message: '临时邮箱系统API正常运行' });
});

// 获取系统配置
app.get('/api/config', (c) => {
  try {
    const emailDomains = c.env.VITE_EMAIL_DOMAIN || '';
    const domains = emailDomains.split(',').map((domain: string) => domain.trim()).filter((domain: string) => domain);

    return c.json({
      success: true,
      config: {
        emailDomains: domains
      }
    });
  } catch (error) {
    console.error('获取配置失败:', error);
    return c.json({
      success: false,
      error: '获取配置失败',
      message: error instanceof Error ? error.message : String(error)
    }, 500);
  }
});

// 入站邮件 Webhook（备用方案）
// 用于在未配置 Cloudflare Email Routing，或需要第三方 SMTP/邮件服务转发时接收邮件
app.post('/api/inbound/email', async (c) => {
  try {
    const secret = c.env.INBOUND_EMAIL_SECRET;
    if (secret) {
      const provided = c.req.header('X-Inbound-Email-Secret') || '';
      if (provided !== secret) {
        return c.json({ success: false, error: '未授权' }, 403);
      }
    }

    const raw = await c.req.arrayBuffer();
    if (!raw || raw.byteLength === 0) {
      return c.json({ success: false, error: '空邮件内容' }, 400);
    }

    await handleEmail({ raw }, c.env);

    return c.json({ success: true });
  } catch (error) {
    console.error('入站邮件处理失败:', error);
    return c.json({
      success: false,
      error: '入站邮件处理失败',
      message: error instanceof Error ? error.message : String(error)
    }, 500);
  }
});

// 邮箱集合（GET 仅返回使用说明，避免直接访问出现 404 造成困惑）
app.get('/api/mailboxes', (c) => {
  return c.json({
    success: true,
    message: '请使用 POST /api/mailboxes 创建邮箱；或 GET /api/mailboxes/:address 查询邮箱信息。',
    usage: {
      createMailbox: {
        method: 'POST',
        path: '/api/mailboxes',
        body: { address: '可选，不传则随机生成' }
      },
      createRandomMailbox: {
        method: 'GET',
        path: '/api/mailboxes/new'
      },
      getMailbox: {
        method: 'GET',
        path: '/api/mailboxes/:address'
      }
    }
  });
});

// 便捷创建随机邮箱（无需 body，便于 curl/脚本调用）
app.get('/api/mailboxes/new', async (c) => {
  try {
    const expiresInHours = 24;
    const ip = c.req.header('CF-Connecting-IP') || 'unknown';

    // 从配置中选一个域名用于拼接完整邮箱
    const emailDomains = c.env.VITE_EMAIL_DOMAIN || '';
    const domains = emailDomains.split(',').map((domain: string) => domain.trim()).filter((domain: string) => domain);
    const selectedDomain = domains[0] || '';

    // 生成一个不重复的地址（最多尝试 5 次）
    let address = '';
    for (let i = 0; i < 5; i++) {
      const candidate = generateRandomAddress();
      const existing = await getMailbox(c.env.DB, candidate);
      if (!existing) {
        address = candidate;
        break;
      }
    }

    if (!address) {
      return c.json({ success: false, error: '生成邮箱失败' }, 500);
    }

    const mailbox = await createMailbox(c.env.DB, {
      address,
      expiresInHours,
      ipAddress: ip,
    });

    const emailAddress = selectedDomain ? `${mailbox.address}@${selectedDomain}` : mailbox.address;

    return c.json({ success: true, mailbox, emailAddress });
  } catch (error) {
    console.error('创建邮箱失败:', error);
    return c.json({
      success: false,
      error: '创建邮箱失败',
      message: error instanceof Error ? error.message : String(error)
    }, 400);
  }
});

// 创建邮箱
app.post('/api/mailboxes', async (c) => {
  try {
    const body = await c.req.json();

    // 验证参数
    if (body.address && typeof body.address !== 'string') {
      return c.json({ success: false, error: '无效的邮箱地址' }, 400);
    }

    const expiresInHours = 24; // 固定24小时有效期

    // 获取客户端IP
    const ip = c.req.header('CF-Connecting-IP') || 'unknown';

    // 生成或使用提供的地址
    const address = body.address || generateRandomAddress();

    // 检查邮箱是否已存在
    const existingMailbox = await getMailbox(c.env.DB, address);
    if (existingMailbox) {
      return c.json({ success: false, error: '邮箱地址已存在' }, 400);
    }

    // 创建邮箱
    const mailbox = await createMailbox(c.env.DB, {
      address,
      expiresInHours,
      ipAddress: ip,
    });

    return c.json({ success: true, mailbox });
  } catch (error) {
    console.error('创建邮箱失败:', error);
    return c.json({
      success: false,
      error: '创建邮箱失败',
      message: error instanceof Error ? error.message : String(error)
    }, 400);
  }
});

// 获取邮箱信息
app.get('/api/mailboxes/:address', async (c) => {
  try {
    const address = c.req.param('address');

    // 避免把文档占位符当成真实参数传入
    if (!address || address.startsWith(':')) {
      return c.json({
        success: false,
        error: '无效的邮箱地址',
        message: '请将 :address 替换为真实邮箱前缀。例如先调用 GET /api/mailboxes/new 获取 address。'
      }, 400);
    }

    const mailbox = await getMailbox(c.env.DB, address);

    if (!mailbox) {
      return c.json({ success: false, error: '邮箱不存在' }, 404);
    }

    return c.json({ success: true, mailbox });
  } catch (error) {
    console.error('获取邮箱失败:', error);
    return c.json({
      success: false,
      error: '获取邮箱失败',
      message: error instanceof Error ? error.message : String(error)
    }, 500);
  }
});

// 删除邮箱
app.delete('/api/mailboxes/:address', async (c) => {
  try {
    const address = c.req.param('address');

    // 避免把文档占位符当成真实参数传入
    if (!address || address.startsWith(':')) {
      return c.json({
        success: false,
        error: '无效的邮箱地址',
        message: '请将 :address 替换为真实邮箱前缀。例如先调用 GET /api/mailboxes/new 获取 address。'
      }, 400);
    }

    await deleteMailbox(c.env.DB, address);

    return c.json({ success: true });
  } catch (error) {
    console.error('删除邮箱失败:', error);
    return c.json({
      success: false,
      error: '删除邮箱失败',
      message: error instanceof Error ? error.message : String(error)
    }, 500);
  }
});

// 获取邮件列表
app.get('/api/mailboxes/:address/emails', async (c) => {
  try {
    const address = c.req.param('address');

    // 避免把文档占位符当成真实参数传入
    if (!address || address.startsWith(':')) {
      return c.json({
        success: false,
        error: '无效的邮箱地址',
        message: '请将 :address 替换为真实邮箱前缀。例如先调用 GET /api/mailboxes/new 获取 address。'
      }, 400);
    }

    const mailbox = await getMailbox(c.env.DB, address);

    if (!mailbox) {
      return c.json({ success: false, error: '邮箱不存在' }, 404);
    }

    const emails = await getEmails(c.env.DB, mailbox.id);

    return c.json({ success: true, emails });
  } catch (error) {
    console.error('获取邮件列表失败:', error);
    return c.json({
      success: false,
      error: '获取邮件列表失败',
      message: error instanceof Error ? error.message : String(error)
    }, 500);
  }
});

// 获取邮件详情
app.get('/api/emails/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const email = await getEmail(c.env.DB, id);

    if (!email) {
      return c.json({ success: false, error: '邮件不存在' }, 404);
    }

    return c.json({ success: true, email });
  } catch (error) {
    console.error('获取邮件详情失败:', error);
    return c.json({
      success: false,
      error: '获取邮件详情失败',
      message: error instanceof Error ? error.message : String(error)
    }, 500);
  }
});

// 获取邮件的附件列表
app.get('/api/emails/:id/attachments', async (c) => {
  try {
    const id = c.req.param('id');

    // 检查邮件是否存在
    const email = await getEmail(c.env.DB, id);
    if (!email) {
      return c.json({ success: false, error: '邮件不存在' }, 404);
    }

    // 获取附件列表
    const attachments = await getAttachments(c.env.DB, id);

    return c.json({ success: true, attachments });
  } catch (error) {
    console.error('获取附件列表失败:', error);
    return c.json({
      success: false,
      error: '获取附件列表失败',
      message: error instanceof Error ? error.message : String(error)
    }, 500);
  }
});

// 获取附件详情
app.get('/api/attachments/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const attachment = await getAttachment(c.env.DB, id);

    if (!attachment) {
      return c.json({ success: false, error: '附件不存在' }, 404);
    }

    // 检查是否需要直接返回附件内容
    const download = c.req.query('download') === 'true';

    if (download) {
      // 将Base64内容转换为二进制
      const binaryContent = atob(attachment.content);
      const bytes = new Uint8Array(binaryContent.length);
      for (let i = 0; i < binaryContent.length; i++) {
        bytes[i] = binaryContent.charCodeAt(i);
      }

      // 设置响应头
      c.header('Content-Type', attachment.mimeType);
      c.header('Content-Disposition', `attachment; filename="${encodeURIComponent(attachment.filename)}"`);

      return c.body(bytes);
    }

    // 返回附件信息（不包含内容，避免响应过大）
    return c.json({
      success: true,
      attachment: {
        id: attachment.id,
        emailId: attachment.emailId,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        size: attachment.size,
        createdAt: attachment.createdAt,
        isLarge: attachment.isLarge,
        chunksCount: attachment.chunksCount
      }
    });
  } catch (error) {
    console.error('获取附件详情失败:', error);
    return c.json({
      success: false,
      error: '获取附件详情失败',
      message: error instanceof Error ? error.message : String(error)
    }, 500);
  }
});

// 删除邮件
app.delete('/api/emails/:id', async (c) => {
  try {
    const id = c.req.param('id');
    await deleteEmail(c.env.DB, id);

    return c.json({ success: true });
  } catch (error) {
    console.error('删除邮件失败:', error);
    return c.json({
      success: false,
      error: '删除邮件失败',
      message: error instanceof Error ? error.message : String(error)
    }, 500);
  }
});

export default app;
