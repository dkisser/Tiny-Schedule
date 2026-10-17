import type { Schedule } from '@tiny-schedule/shared';
import {
  isScheduleKind,
  SCHEDULE_KIND_LABELS,
  type ScheduleKind,
  WEEKDAY_LABELS,
} from '@/lib/scheduledTasks';
import { cn } from '@/lib/utils';
import { Checkbox } from '../ui/checkbox';
import { Input } from '../ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';

/** 星期几按周一在前排布，符合中文日历的习惯；索引仍是 0 = 周日。 */
const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

/** 「每月几号」的取值范围，与 Schedule 类型的 dayOfMonth 一致。 */
const DAY_OF_MONTH_OPTIONS = Array.from({ length: 31 }, (_, i) => i + 1);

/**
 * 频率（Schedule）的结构化编辑器：每天 / 每周几 / 每月几号 + 时刻。
 *
 * 刻意不做成 cron 字符串或自然语言输入——CONTEXT.md 说频率就是这三种结构，每种
 * 带自己需要的判别字段。自由文本会允许"每周不选任何一天"这种永不触发的规则静默
 * 存进去，所以这里让每一项只能从合法取值里选。
 */
export function ScheduleEditor({
  value,
  onChange,
  disabled = false,
}: {
  value: Schedule;
  onChange: (next: Schedule) => void;
  disabled?: boolean;
}) {
  const changeKind = (kind: ScheduleKind) => {
    if (kind === value.kind) return;
    if (kind === 'daily') onChange({ kind: 'daily', time: value.time });
    else if (kind === 'weekly')
      // 换到"每周几"时给一个默认的日子，否则会落下一个空的 daysOfWeek——
      // 那是 schema 会拒绝、界面却看不出错在哪的形状。
      onChange({ kind: 'weekly', daysOfWeek: [new Date().getDay()], time: value.time });
    else onChange({ kind: 'monthly', dayOfMonth: 1, time: value.time });
  };

  const toggleDay = (day: number, checked: boolean) => {
    if (value.kind !== 'weekly') return;
    const current = value.daysOfWeek;
    const daysOfWeek = checked ? [...new Set([...current, day])] : current.filter((d) => d !== day);
    // 至少保留一天：空数组在存储层会被拒，而界面上没有任何东西能把它改回来。
    if (daysOfWeek.length === 0) return;
    onChange({ ...value, daysOfWeek: [...daysOfWeek].sort((a, b) => a - b) });
  };

  const time = (
    <div className="flex items-center gap-2">
      <span className="text-xs text-muted-foreground">时刻</span>
      <Input
        type="time"
        aria-label="时刻"
        value={value.time}
        disabled={disabled}
        onChange={(e) => {
          // 空串与非法值都不提交：一次提交一个非法时刻会让整条定时任务存不进去，
          // 而用户看到的只是输入框被清空，没有任何解释。
          if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(e.target.value)) return;
          onChange({ ...value, time: e.target.value });
        }}
        className="h-8 w-auto"
      />
    </div>
  );

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">频率</span>
        <Select
          value={value.kind}
          disabled={disabled}
          onValueChange={(kind) => {
            if (isScheduleKind(kind)) changeKind(kind);
          }}
        >
          <SelectTrigger size="sm" className="w-32" aria-label="频率类型">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(SCHEDULE_KIND_LABELS).map(([kind, label]) => (
              <SelectItem key={kind} value={kind}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {time}
      </div>

      {value.kind === 'weekly' && (
        <div className="flex flex-wrap items-center gap-3 pl-14">
          {WEEKDAY_ORDER.map((day) => {
            const checked = value.daysOfWeek.includes(day);
            return (
              <label key={day} className="flex items-center gap-1.5 text-xs">
                <Checkbox
                  checked={checked}
                  disabled={disabled || (checked && value.daysOfWeek.length === 1)}
                  aria-label={WEEKDAY_LABELS[day]}
                  onCheckedChange={(next) => toggleDay(day, next === true)}
                />
                <span className={cn(checked ? 'text-foreground' : 'text-muted-foreground')}>
                  {WEEKDAY_LABELS[day]}
                </span>
              </label>
            );
          })}
        </div>
      )}

      {value.kind === 'monthly' && (
        <div className="flex items-center gap-2 pl-14">
          <Select
            value={String(value.dayOfMonth)}
            disabled={disabled}
            onValueChange={(raw) => {
              const dayOfMonth = Number(raw);
              if (Number.isInteger(dayOfMonth)) onChange({ ...value, dayOfMonth });
            }}
          >
            <SelectTrigger size="sm" className="w-28" aria-label="每月几号">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DAY_OF_MONTH_OPTIONS.map((day) => (
                <SelectItem key={day} value={String(day)}>
                  {day} 号
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="text-xs text-muted-foreground">
            没有这一天的月份（如 2 月 31 日）会跳过，不补跑。
          </span>
        </div>
      )}
    </div>
  );
}
