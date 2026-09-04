/* ============================================================================
 * Canonical ISO-8601 timestamps: exactly the `YYYY-MM-DDTHH:mm:ss.sssZ` form
 * `new Date().toISOString()` emits — always three digits of milliseconds, always
 * `Z`, never an offset.
 *
 * WHY THIS IS IN THE KERNEL, and why it takes epoch milliseconds rather than a
 * `Date`. Three modules need this exact spelling: the store's journal and
 * bookkeeping, the SPT durable records, and the app. A second implementation is a
 * second chance to disagree about a leap year or a pre-epoch instant, and these
 * timestamps are re-validated by ROUND TRIP — a record whose `at` does not
 * re-format to itself is refused — so a disagreement is a refusal, not a cosmetic
 * bug.
 *
 * TruePadCore depends on NOTHING, Foundation included, so the civil-date
 * arithmetic is done here by hand over an integer. Callers holding a `Date`
 * convert at the boundary.
 * ========================================================================= */

public enum IsoTime {
    /// Exactly seven days as a duration in milliseconds — NOT "the same clock
    /// time seven days later", which stretches across a DST boundary.
    public static let sevenDaysMillis = 7 * 24 * 60 * 60 * 1000

    /// Render epoch milliseconds as the canonical spelling. Total: every integer
    /// has a rendering, before the epoch included.
    public static func format(epochMillis: Int) -> String {
        let seconds = floorDiv(epochMillis, 1000)
        let ms = epochMillis - seconds * 1000          // always in 0..<1000

        var days = floorDiv(seconds, 86_400)
        var rest = seconds - days * 86_400             // always in 0..<86400
        let hh = rest / 3600; rest -= hh * 3600
        let mm = rest / 60
        let ss = rest - mm * 60

        // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
        days += 719_468
        let era = floorDiv(days, 146_097)
        let doe = days - era * 146_097                 // 0..=146096
        let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365
        let y = yoe + era * 400
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100)
        let mp = (5 * doy + 2) / 153
        let d = doy - (153 * mp + 2) / 5 + 1
        let m = mp < 10 ? mp + 3 : mp - 9
        let year = m <= 2 ? y + 1 : y

        return pad(year, 4) + "-" + pad(m, 2) + "-" + pad(d, 2)
            + "T" + pad(hh, 2) + ":" + pad(mm, 2) + ":" + pad(ss, 2)
            + "." + pad(ms, 3) + "Z"
    }

    /// Parse EXACTLY the canonical spelling and nothing else.
    ///
    /// Anything that is not `YYYY-MM-DDTHH:mm:ss.sssZ` returns nil rather than
    /// being coerced — no offsets, no missing or extra millisecond digits, no
    /// lowercase `z`, no space in place of `T`. That strictness is what makes the
    /// round-trip check meaningful.
    public static func parseMillis(_ text: String) -> Int? {
        let c = Array(text)
        guard c.count == 24, c[4] == "-", c[7] == "-", c[10] == "T",
              c[13] == ":", c[16] == ":", c[19] == ".", c[23] == "Z" else { return nil }
        func num(_ from: Int, _ to: Int) -> Int? {
            var value = 0
            for i in from..<to {
                guard let digit = c[i].wholeNumberValue, c[i].isASCII, c[i].isNumber else { return nil }
                value = value * 10 + digit
            }
            return value
        }
        guard let year = num(0, 4), let month = num(5, 7), let day = num(8, 10),
              let hour = num(11, 13), let minute = num(14, 16), let second = num(17, 19),
              let milli = num(20, 23) else { return nil }
        guard (1...12).contains(month), (1...31).contains(day),
              hour < 24, minute < 60, second < 60 else { return nil }
        // Reject a day that does not exist in that month, so 2025-02-30 cannot
        // round-trip into 2025-03-02.
        guard day <= daysInMonth(year: year, month: month) else { return nil }

        // Days from civil — the inverse of the algorithm above.
        let y = month <= 2 ? year - 1 : year
        let era = floorDiv(y, 400)
        let yoe = y - era * 400
        let mp = month > 2 ? month - 3 : month + 9
        let doy = (153 * mp + 2) / 5 + day - 1
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
        let days = era * 146_097 + doe - 719_468

        return days * 86_400_000 + hour * 3_600_000 + minute * 60_000 + second * 1000 + milli
    }

    /// A canonical timestamp is one whose parse re-formats to the identical
    /// spelling. This is the check every durable record's `at` field must pass.
    public static func isCanonical(_ text: String) -> Bool {
        guard let millis = parseMillis(text) else { return false }
        return format(epochMillis: millis) == text
    }

    // ---- helpers ------------------------------------------------------------

    /// Floor division: Swift's `/` truncates toward zero, which is wrong for
    /// pre-epoch instants (-1 ms must be 1969-12-31T23:59:59.999Z, not 1970).
    static func floorDiv(_ a: Int, _ b: Int) -> Int {
        let q = a / b
        return (a % b != 0 && (a < 0) != (b < 0)) ? q - 1 : q
    }

    static func daysInMonth(year: Int, month: Int) -> Int {
        switch month {
        case 1, 3, 5, 7, 8, 10, 12: return 31
        case 4, 6, 9, 11: return 30
        default:
            let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
            return leap ? 29 : 28
        }
    }

    static func pad(_ value: Int, _ width: Int) -> String {
        let s = String(value)
        return s.count >= width ? s : String(repeating: "0", count: width - s.count) + s
    }
}
