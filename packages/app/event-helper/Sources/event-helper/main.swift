// event-helper: 把 Tiny-Schedule 任务写入 macOS 系统日历(EventKit)。
// 协议:从 stdin 读 JSON,从 stdout 写 JSON(单行)。
//
// 请求:
//   { "title": "...", "dueDay": "YYYY-MM-DD", "notes": "..." }
//
// 响应:
//   { "ok": true, "eventId": "..." }
//   { "ok": false, "code": "permission-denied" | "calendar-app-unavailable" | "unknown", "message": "..." }
//
// 硬编码:全天事件,提前 15 分钟提醒,默认日历。
// 退出码:0 = 成功;非 0 = 协议或运行时错误。

import EventKit
import Foundation

// MARK: - 请求 / 响应模型(手写解析避免依赖 Codable 协议开销)

struct Input: Decodable {
    let title: String
    let dueDay: String
    let notes: String
}

enum OutputCode: String {
    case permissionDenied = "permission-denied"
    case calendarAppUnavailable = "calendar-app-unavailable"
    case unknown
}

struct OutputSuccess: Encodable {
    let ok: Bool
    let eventId: String
}

struct OutputFailure: Encodable {
    let ok: Bool
    let code: String
    let message: String
}

// MARK: - 工具

/// 输出 JSON 后立即 flush,父进程能立即读到。
func emit<T: Encodable>(_ value: T) {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.withoutEscapingSlashes]
    if let data = try? encoder.encode(value),
       let line = String(data: data, encoding: .utf8) {
        FileHandle.standardOutput.write((line + "\n").data(using: .utf8)!)
    }
}

func fail(_ code: OutputCode, _ message: String) -> Never {
    emit(OutputFailure(ok: false, code: code.rawValue, message: message))
    exit(0) // 协议层错误仍走 ok:false,exit 0;协议 / 进程异常才 exit 非 0
}

/// 把 "YYYY-MM-DD" 解析为本地时区当日 00:00;end = next day 00:00。
func dateRange(from dueDay: String) throws -> (Date, Date) {
    let formatter = DateFormatter()
    formatter.dateFormat = "yyyy-MM-dd"
    formatter.timeZone = .current
    formatter.locale = Locale(identifier: "en_US_POSIX")
    guard let start = formatter.date(from: dueDay) else {
        throw NSError(
            domain: "event-helper", code: 1,
            userInfo: [NSLocalizedDescriptionKey: "invalid dueDay: \(dueDay)"])
    }
    guard let end = Calendar.current.date(byAdding: .day, value: 1, to: start) else {
        throw NSError(
            domain: "event-helper", code: 2,
            userInfo: [NSLocalizedDescriptionKey: "failed to compute end date"])
    }
    return (start, end)
}

/// macOS 14+:requestFullAccessToEvents 是异步的;包一层 sync wrapper。
/// 父进程只在 GUI session 里 spawn(electron 主进程),所以 prompt 一定能弹。
private final class ResultBox<T>: @unchecked Sendable {
    var value: Result<T, Error>?
}

func runAsync<T>(_ asyncFn: @escaping () async throws -> T) throws -> T {
    let semaphore = DispatchSemaphore(value: 0)
    let box = ResultBox<T>()
    Task {
        do {
            let value = try await asyncFn()
            box.value = .success(value)
        } catch {
            box.value = .failure(error)
        }
        semaphore.signal()
    }
    semaphore.wait()
    guard let result = box.value else {
        throw NSError(
            domain: "event-helper", code: 3,
            userInfo: [NSLocalizedDescriptionKey: "async result missing"])
    }
    return try result.get()
}

// MARK: - 主流程

func main() throws {
    // 读 stdin 全部内容
    let raw = FileHandle.standardInput.readDataToEndOfFile()
    guard !raw.isEmpty else {
        fail(.unknown, "empty stdin")
    }
    let input: Input
    do {
        input = try JSONDecoder().decode(Input.self, from: raw)
    } catch {
        fail(.unknown, "invalid JSON: \(error.localizedDescription)")
        return
    }

    let store = EKEventStore()

    // 1. 权限
    let granted: Bool
    do {
        granted = try runAsync { try await store.requestFullAccessToEvents() }
    } catch {
        fail(.permissionDenied, "requestFullAccessToEvents threw: \(error.localizedDescription)")
        return
    }
    guard granted else {
        fail(.permissionDenied, "用户未授权日历访问")
        return
    }

    // 2. 默认日历
    guard let calendar = store.defaultCalendarForNewEvents else {
        fail(.calendarAppUnavailable, "无法获取默认日历")
        return
    }

    // 3. 日期范围
    let (start, end) = try dateRange(from: input.dueDay)

    // 4. 创建事件
    let event = EKEvent(eventStore: store)
    event.title = input.title
    event.notes = input.notes
    event.calendar = calendar
    event.isAllDay = true
    event.startDate = start
    event.endDate = end
    // 提前 15 分钟:relativeOffset 单位是秒,负值表示提前。
    event.addAlarm(EKAlarm(relativeOffset: -15 * 60))

    // 5. 保存
    do {
        try store.save(event, span: .thisEvent, commit: true)
    } catch {
        fail(.unknown, "save failed: \(error.localizedDescription)")
        return
    }

    emit(OutputSuccess(ok: true, eventId: event.eventIdentifier ?? ""))
    exit(0)
}

do {
    try main()
} catch {
    fail(.unknown, "fatal: \(error.localizedDescription)")
}