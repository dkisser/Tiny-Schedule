import { describe, expect, test } from 'bun:test';
import { installTauriMocks } from '@/test/tauriMocks';

/**
 * 通知权限的缓存语义。
 *
 * macOS 的授权提示是一次性的，而"没授权"和"已授权"会随用户在系统设置里的操作
 * 改变。把拒绝也永久缓存住，于是用户明明后来在系统设置里开了通知，这个进程之后
 * 的每一次定时运行都仍然发不出去——而记录里只留一句 warn。
 */

/**
 * 一套可变的宿主假件。授权状态由测试改写，用来模拟"用户去了系统设置"。
 */
let granted = false;
let answer: 'granted' | 'denied' = 'denied';
let sent: { title: string; body: string }[] = [];

installTauriMocks({
  notification: {
    isPermissionGranted: async () => granted,
    requestPermission: async () => answer,
    sendNotification: async (payload: { title: string; body: string }) => {
      sent.push(payload);
    },
  },
});

const { _resetPermissionForTest, notifyScheduledTask: notify } = await import('./runtime');

describe('通知权限的缓存', () => {
  test('被拒之后不弹第二次授权框', async () => {
    _resetPermissionForTest();
    granted = false;
    answer = 'denied';
    sent = [];

    await notify({ title: '第一次', body: 'a' });
    await notify({ title: '第二次', body: 'b' });

    expect(sent).toHaveLength(0);
  });

  test('用户后来在系统设置里开启通知，本进程能恢复', async () => {
    // 拒绝被缓存过之后，用户去系统设置打开了通知。进程还在跑，下一次定时运行
    // 应该发得出通知——而不是永远沿用那个被拒绝的进程级缓存。
    _resetPermissionForTest();
    granted = false;
    answer = 'denied';
    sent = [];

    await notify({ title: '第一次', body: '被拒' });
    expect(sent).toHaveLength(0);

    granted = true; // 用户在系统设置里开了通知

    await notify({ title: '第二次', body: '应发出' });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.title).toBe('第二次');
  });

  test('已授权时正常发出', async () => {
    _resetPermissionForTest();
    granted = true;
    sent = [];

    await notify({ title: 'a', body: 'b' });

    expect(sent).toHaveLength(1);
  });
});
