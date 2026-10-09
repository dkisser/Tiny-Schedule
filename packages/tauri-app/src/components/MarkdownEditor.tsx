import Cherry from 'cherry-markdown';
import 'cherry-markdown/dist/cherry-markdown.min.css';
import { Maximize2, Minimize2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { cn } from '../lib/utils';
import { Button } from './ui/button';

export function MarkdownEditor({
  initialValue,
  onDone,
  onCancel,
  onReady,
  onUnmount,
}: {
  initialValue: string;
  onDone: (text: string) => void;
  onCancel: () => void;
  /**
   * Cherry 实例就绪时回调（mount 时传入实例，cleanup 时传入 null）。
   * 让父组件在切换上下文时能读取未通过 Done 按钮提交的编辑内容。
   */
  onReady?: (cherry: Cherry | null) => void;
  /**
   * Cherry 销毁前回调，传入最新文本。
   * 父组件可在编辑器被卸载（如切换任务、关闭面板）前 flush 未保存的编辑。
   */
  onUnmount?: (latest: string) => void;
}) {
  const holderRef = useRef<HTMLDivElement>(null);
  const cherryRef = useRef<Cherry | null>(null);
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    if (!holderRef.current) return;
    const cherry = new Cherry({
      el: holderRef.current,
      value: initialValue,
      // 非全屏只编辑不预览；全屏时通过 switchModel 切到编辑+预览
      editor: { defaultModel: 'editOnly' },
      toolbars: {
        toolbar: [
          'bold',
          'italic',
          'strikethrough',
          '|',
          'list',
          'ol',
          'checklist',
          '|',
          'header',
          'quote',
          'code',
          'insert-code',
          'link',
          'table',
          '|',
          'undo',
          'redo',
        ],
      },
    });
    cherryRef.current = cherry;
    onReady?.(cherry);
    return () => {
      // 先把最新文本交给父组件（父组件的 useEffect cleanup 会在子组件之后才跑，
      // 所以这里需要在 destroy 之前同步给父组件一个读取的机会）。
      onUnmount?.(cherry.getValue());
      onReady?.(null);
      cherry.destroy();
      cherryRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    cherryRef.current?.switchModel(fullscreen ? 'edit&preview' : 'editOnly');
    // 容器尺寸变化后通知内部编辑器重排
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  }, [fullscreen]);

  return (
    <div
      className={cn('flex flex-col gap-1.5', fullscreen && 'fixed inset-0 z-50 bg-background p-4')}
    >
      <div
        ref={holderRef}
        className={cn(
          'overflow-hidden rounded-md border border-border',
          fullscreen ? 'min-h-0 flex-1' : 'h-48',
        )}
      />
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => setFullscreen((f) => !f)}
          aria-label={fullscreen ? '退出全屏' : '全屏编辑'}
        >
          {fullscreen ? <Minimize2 /> : <Maximize2 />}
          {fullscreen ? '退出全屏' : '全屏'}
        </Button>
        <div className="ml-auto flex gap-2">
          <Button variant="outline" size="sm" onClick={onCancel}>
            取消
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onDone(cherryRef.current?.getValue() ?? initialValue)}
          >
            完成
          </Button>
        </div>
      </div>
    </div>
  );
}
