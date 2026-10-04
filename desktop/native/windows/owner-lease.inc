std::string line() {
    std::string result;
    for (;;) {
        int c = fgetc(stdin);
        if (c == EOF) { require(result.empty()); return {}; }
        if (c == '\n') return result;
        require(c >= 9 && c <= 126 && c != '\r' && result.size() < 8192);
        result += static_cast<char>(c);
    }
}
std::vector<std::string> split(const std::string& text) {
    std::vector<std::string> values; size_t previous = 0;
    for (;;) { auto index = text.find('\t', previous); values.push_back(text.substr(previous, index - previous)); if (index == std::string::npos) return values; previous = index + 1; }
}
bool alphabet(const std::string& s, const std::string& chars, size_t maximum) { return !s.empty() && s.size() <= maximum && s.find_first_not_of(chars) == std::string::npos; }
void lease() {
    auto parts = split(line());
    const std::string letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
    require(parts.size() == 5 && parts[0] == "ACQUIRE" && alphabet(parts[1], letters, 5462) && alphabet(parts[2], letters, 128));
    require(parts[3] == "purpose-keyring" || parts[3] == "ai-journal" || parts[3] == "source-vault");
    require(parts[4].size() == 32 && alphabet(parts[4], "0123456789abcdef", 32));
    auto encoded = parts[1]; std::replace(encoded.begin(), encoded.end(), '-', '+'); std::replace(encoded.begin(), encoded.end(), '_', '/');
    while (encoded.size() % 4) encoded += '=';
    DWORD size = 0;
    require(CryptStringToBinaryA(encoded.c_str(), static_cast<DWORD>(encoded.size()), CRYPT_STRING_BASE64 | CRYPT_STRING_STRICT, nullptr, &size, nullptr, nullptr) != 0 && size <= 4096);
    std::string decoded(size, '\0');
    require(CryptStringToBinaryA(encoded.c_str(), static_cast<DWORD>(encoded.size()), CRYPT_STRING_BASE64 | CRYPT_STRING_STRICT, reinterpret_cast<BYTE*>(decoded.data()), &size, nullptr, nullptr) != 0);
    DWORD encodedLength = 0;
    require(CryptBinaryToStringA(reinterpret_cast<const BYTE*>(decoded.data()), size, CRYPT_STRING_BASE64 | CRYPT_STRING_NOCRLF, nullptr, &encodedLength) != 0);
    std::string canonical(encodedLength, '\0');
    require(CryptBinaryToStringA(reinterpret_cast<const BYTE*>(decoded.data()), size, CRYPT_STRING_BASE64 | CRYPT_STRING_NOCRLF, canonical.data(), &encodedLength) != 0);
    canonical.resize(encodedLength);
    while (!canonical.empty() && (canonical.back() == '=' || canonical.back() == '\0')) canonical.pop_back();
    std::replace(canonical.begin(), canonical.end(), '+', '-'); std::replace(canonical.begin(), canonical.end(), '/', '_');
    require(canonical == parts[1]);
    auto root = checkedPath(wide(decoded));
    auto dir = root + L"\\" + wide(parts[3]);
    auto p = dir + (parts[3] == "ai-journal" ? L"\\writer.lock" : L"\\owner.lock");
    auto chain = ancestors(p);
    require(chain.size() >= 2);
    inspect(chain[chain.size() - 2].value, true, true); inspect(chain.back().value, true, true);
    std::array<unsigned char,32> digest{};
    require(BCryptHash(BCRYPT_SHA256_ALG_HANDLE, nullptr, 0, reinterpret_cast<PUCHAR>(parts[2].data()), static_cast<ULONG>(parts[2].size()), digest.data(), static_cast<ULONG>(digest.size())) == 0);
    std::string identity;
    for (auto c : digest) { identity += "0123456789abcdef"[c >> 4]; identity += "0123456789abcdef"[c & 15]; }
    const auto marker = "CI-NATIVE-OWNER-2\n" + identity + "\n" + parts[3] + "\n";
    PrivateSecurity sec;
    Handle file(CreateFileW(p.c_str(), GENERIC_READ | GENERIC_WRITE | READ_CONTROL, FILE_SHARE_READ | FILE_SHARE_WRITE, &sec.attributes, CREATE_NEW, FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_WRITE_THROUGH, nullptr));
    bool created = file.value != INVALID_HANDLE_VALUE;
    if (!created) { require(GetLastError() == ERROR_FILE_EXISTS); file = openObject(p, false, GENERIC_READ | GENERIC_WRITE | READ_CONTROL, FILE_SHARE_READ | FILE_SHARE_WRITE); }
    inspect(file.value, false, true);
    OVERLAPPED lock{};
    require(LockFileEx(file.value, LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY, 0, MAXDWORD, MAXDWORD, &lock) != 0);
    if (created) writeAll(file.value, reinterpret_cast<const unsigned char*>(marker.data()), marker.size());
    const auto original = inspect(file.value, false, true);
    auto held = [&]() {
        require(same(original, inspect(file.value, false, true)) && original.nFileSizeHigh == 0 && original.nFileSizeLow == marker.size());
        LARGE_INTEGER start{}; require(SetFilePointerEx(file.value, start, nullptr, FILE_BEGIN) != 0);
        std::array<char,256> bytes{}; DWORD received = 0;
        require(ReadFile(file.value, bytes.data(), static_cast<DWORD>(bytes.size()), &received, nullptr) && received == marker.size() && memcmp(bytes.data(), marker.data(), marker.size()) == 0);
        inspect(chain[chain.size() - 2].value, true, true); inspect(chain.back().value, true, true);
    };
    held(); auto ready = "READY\t" + parts[4] + "\n"; output(ready.data(), ready.size());
    uint64_t sequence = 0;
    for (;;) {
        auto command = line(); if (command.empty()) return;
        auto request = split(command);
        require(request.size() == 2 && alphabet(request[1], "0123456789", 15) && request[1][0] != '0');
        require(request[1] == std::to_string(++sequence)); held();
        std::string reply;
        if (request[0] == "CHECK") reply = "HELD\t" + request[1] + "\n";
        else if (request[0] == "RELEASE") { require(UnlockFileEx(file.value, 0, MAXDWORD, MAXDWORD, &lock) != 0); reply = "RELEASED\t" + request[1] + "\n"; }
        else fail();
        output(reply.data(), reply.size()); if (request[0] == "RELEASE") return;
    }
}
