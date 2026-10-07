package dev.codeintelligence.ai;

import java.time.DateTimeException;
import java.time.LocalDate;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.function.Predicate;
import java.util.function.UnaryOperator;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Default personal-data masking for outgoing AI prompts (applied after {@code SecretMask}). Each detected
 * value becomes a placeholder such as {@code [EMAIL_1]}; the same value gets the same placeholder within one
 * call, and no part of the value is kept. Matches never cross a line, so evidence line references stay valid.
 *
 * <p>Limits: detection is pattern based. Names, postal addresses and personal data written without the
 * listed formats are not detected; phone numbers need a {@code +} country code, a Korean area/mobile prefix
 * with separators (or an 11-digit {@code 01x} mobile run), or the North American {@code (NXX) NXX-XXXX} /
 * {@code NXX-NXX-XXXX} shape. Values glued to letters, digits, {@code _}, {@code .}, {@code -}, {@code +}
 * or {@code @} are left alone so identifiers, versions and hashes are not masked.
 */
public final class PersonalDataMask {

    private record Rule(String kind, Pattern pattern, Predicate<String> accept, UnaryOperator<String> identity) {}

    private static final String START = "(?<![\\w.+\\-@])";
    private static final String END = "(?![\\w@]|[.\\-]\\d)";
    private static final UnaryOperator<String> DIGITS = value -> value.replaceAll("\\D", "");

    private static final List<Rule> RULES = List.of(
            // Local part not preceded by "scheme://" (URI userinfo); "git@host" SSH remotes are not personal.
            new Rule(
                    "EMAIL",
                    Pattern.compile("(?<![\\w.%+\\-]|://)[A-Za-z0-9._%+\\-]{1,64}@"
                            + "(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\\.)+[A-Za-z]{2,24}(?![\\w\\-])"),
                    value -> !value.toLowerCase(Locale.ROOT).startsWith("git@"),
                    value -> value.toLowerCase(Locale.ROOT)),
            // Korean resident registration number: hyphenated with a valid birth date, or unhyphenated only
            // when the pre-2020 check digit also holds.
            new Rule("RRN", Pattern.compile(START + "\\d{6}-[1-8]\\d{6}" + END), PersonalDataMask::rrnDate, DIGITS),
            new Rule(
                    "RRN",
                    Pattern.compile(START + "\\d{6}[1-8]\\d{6}" + END),
                    value -> rrnDate(value) && rrnChecksum(value),
                    DIGITS),
            // Payment cards: issuer prefix 2-6, 13-19 digits, contiguous or in 4-4-4-x / 4-6-5 groups, Luhn valid.
            new Rule("CARD", Pattern.compile(START + "[2-6]\\d{12,18}" + END), PersonalDataMask::luhn, DIGITS),
            new Rule(
                    "CARD",
                    Pattern.compile(START + "[2-6]\\d{3}([ \\-])\\d{4}\\1\\d{4}\\1\\d{1,7}" + END),
                    PersonalDataMask::luhn,
                    DIGITS),
            new Rule(
                    "CARD",
                    Pattern.compile(START + "3[47]\\d{2}([ \\-])\\d{6}\\1\\d{5}" + END),
                    PersonalDataMask::luhn,
                    DIGITS),
            new Rule("SSN", Pattern.compile(START + "\\d{3}-\\d{2}-\\d{4}" + END), PersonalDataMask::ssn, DIGITS),
            // International E.164-style number with an explicit country code (8-15 digits in total).
            new Rule(
                    "PHONE",
                    Pattern.compile(START + "\\+[1-9]\\d{0,2}(?:[ .\\-]?\\(?\\d{1,4}\\)?){1,5}" + END),
                    value -> {
                        int digits = DIGITS.apply(value).length();
                        return digits >= 8 && digits <= 15;
                    },
                    DIGITS),
            // Korean mobile and area-code numbers with consistent separators, or an 11-digit 01x mobile run.
            new Rule(
                    "PHONE",
                    Pattern.compile(START + "(?:01[016789]|0(?:2|3[1-3]|4[1-4]|5[1-5]|6[1-4]|70))([ .\\-])"
                            + "\\d{3,4}\\1\\d{4}" + END),
                    value -> true,
                    DIGITS),
            new Rule("PHONE", Pattern.compile(START + "01[016789]\\d{8}" + END), value -> true, DIGITS),
            // North American numbers: (NXX) NXX-XXXX or NXX-NXX-XXXX / NXX.NXX.XXXX.
            new Rule(
                    "PHONE",
                    Pattern.compile(
                            "(?<![\\w.+\\-@(])(?:\\([2-9]\\d{2}\\) ?|[2-9]\\d{2}([.\\-]))[2-9]\\d{2}[.\\-]\\d{4}"
                                    + END),
                    value -> true,
                    DIGITS));

    private PersonalDataMask() {}

    public static String mask(String text) {
        if (text == null || text.isEmpty()) {
            return text;
        }
        Map<String, Map<String, Integer>> seen = new HashMap<>();
        String masked = text;
        for (Rule rule : RULES) {
            masked = rule.pattern().matcher(masked).replaceAll(match -> {
                String value = match.group();
                if (!rule.accept().test(value)) {
                    return Matcher.quoteReplacement(value);
                }
                Map<String, Integer> ids = seen.computeIfAbsent(rule.kind(), kind -> new HashMap<>());
                int id = ids.computeIfAbsent(rule.identity().apply(value), key -> ids.size() + 1);
                return "[" + rule.kind() + "_" + id + "]";
            });
        }
        return masked;
    }

    public static boolean detects(String text) {
        return text != null && !mask(text).equals(text);
    }

    private static boolean rrnDate(String value) {
        String digits = DIGITS.apply(value);
        int century =
                switch (digits.charAt(6)) {
                    case '1', '2', '5', '6' -> 1900;
                    default -> 2000;
                };
        try {
            LocalDate.of(
                    century + Integer.parseInt(digits.substring(0, 2)),
                    Integer.parseInt(digits.substring(2, 4)),
                    Integer.parseInt(digits.substring(4, 6)));
            return true;
        } catch (DateTimeException invalid) {
            return false;
        }
    }

    private static boolean rrnChecksum(String digits) {
        int[] weights = {2, 3, 4, 5, 6, 7, 8, 9, 2, 3, 4, 5};
        int sum = 0;
        for (int i = 0; i < weights.length; i++) {
            sum += (digits.charAt(i) - '0') * weights[i];
        }
        return (11 - sum % 11) % 10 == digits.charAt(12) - '0';
    }

    private static boolean luhn(String value) {
        String digits = DIGITS.apply(value);
        if (digits.length() < 13 || digits.length() > 19) {
            return false;
        }
        int sum = 0;
        for (int i = 0; i < digits.length(); i++) {
            int digit = digits.charAt(digits.length() - 1 - i) - '0';
            if (i % 2 == 1) {
                digit = digit * 2 > 9 ? digit * 2 - 9 : digit * 2;
            }
            sum += digit;
        }
        return sum % 10 == 0;
    }

    private static boolean ssn(String value) {
        int area = Integer.parseInt(value.substring(0, 3));
        return area != 0 && area != 666 && area < 900 && !value.startsWith("00", 4) && !value.endsWith("0000");
    }
}
