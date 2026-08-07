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
}: {
  initialValue: string;
  onDone: (text: string) => void;
  onCancel: () => void;
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
    return () => {
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
          {fullscreen ? (
            <Minimize2 className="mr-1 h-3 w-3" />
          ) : (
            <Maximize2 className="mr-1 h-3 w-3" />
          )}
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
