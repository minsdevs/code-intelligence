#include <winsock2.h>
#include <windows.h>
#include <afunix.h>
#include <aclapi.h>
#include <sddl.h>
#include <bcrypt.h>
#include <wincrypt.h>
#include <algorithm>
#include <array>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <cwctype>
#include <io.h>
#include <fcntl.h>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>
#include <unordered_map>

// No paths, payloads or Win32 messages are emitted on failure. This executable is
// a fixed bundled capability, not an arbitrary command interpreter.
namespace {
[[noreturn]] void fail() { throw std::runtime_error("BOUNDARY_REFUSED"); }
void require(bool value) { if (!value) fail(); }
struct Handle {
    HANDLE value = INVALID_HANDLE_VALUE;
    explicit Handle(HANDLE h = INVALID_HANDLE_VALUE) : value(h) {}
    ~Handle() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); }
    Handle(Handle&& other) noexcept : value(other.value) { other.value = INVALID_HANDLE_VALUE; }
    Handle& operator=(Handle&& other) noexcept {
        if (this != &other) { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); value = other.value; other.value = INVALID_HANDLE_VALUE; }
        return *this;
    }
    Handle(const Handle&) = delete;
    Handle& operator=(const Handle&) = delete;
};
struct Secret {
    std::vector<unsigned char> data;
    Secret() = default;
    Secret(Secret&&) noexcept = default;
    Secret(const Secret&) = delete;
    ~Secret() { if (!data.empty()) SecureZeroMemory(data.data(), data.size()); }
};
struct LocalFreeDeleter { void operator()(void* p) const { if (p) LocalFree(p); } };
using Local = std::unique_ptr<void, LocalFreeDeleter>;
std::vector<unsigned char> currentUser;
PSID userSid() { return reinterpret_cast<TOKEN_USER*>(currentUser.data())->User.Sid; }
void initialize() {
    Handle token;
    require(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token.value) != 0);
    DWORD length = 0;
    GetTokenInformation(token.value, TokenUser, nullptr, 0, &length);
    require(length > 0 && length < 65536);
    currentUser.resize(length);
    require(GetTokenInformation(token.value, TokenUser, currentUser.data(), length, &length) != 0);
    require(setvbuf(stdin, nullptr, _IONBF, 0) == 0);
    require(setvbuf(stdout, nullptr, _IONBF, 0) == 0);
    require(SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32) != 0);
    require(SetDllDirectoryW(L"") != 0);
    _setmode(_fileno(stdin), _O_BINARY);
    _setmode(_fileno(stdout), _O_BINARY);
}
std::wstring wide(const std::string& text) {
    require(text.find('\0') == std::string::npos && text.size() <= 32768);
    if (text.empty()) return {};
    int n = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()), nullptr, 0);
    require(n > 0);
    std::wstring result(static_cast<size_t>(n), L'\0');
    require(MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()), result.data(), n) == n);
    return result;
}
std::wstring checkedPath(const std::wstring& p) {
    require(p.size() > 3 && p.size() <= 4096 && ((p[0] >= L'A' && p[0] <= L'Z') || (p[0] >= L'a' && p[0] <= L'z')) && p[1] == L':' && p[2] == L'\\');
    size_t begin = 3;
    for (size_t i = 3; i <= p.size(); ++i) {
        if (i == p.size() || p[i] == L'\\') {
            auto part = p.substr(begin, i - begin);
            require(!part.empty() && part != L"." && part != L".." && part.back() != L'.' && part.back() != L' ');
            auto name = part.substr(0, part.find(L'.'));
            std::transform(name.begin(), name.end(), name.begin(), [](wchar_t c) { return static_cast<wchar_t>(towupper(c)); });
            require(name != L"CON" && name != L"PRN" && name != L"AUX" && name != L"NUL");
            require(!(name.size() == 4 && (name.substr(0,3) == L"COM" || name.substr(0,3) == L"LPT") && ((name[3] >= L'1' && name[3] <= L'9') || name[3] == L'\u00b9' || name[3] == L'\u00b2' || name[3] == L'\u00b3')));
            begin = i + 1;
        } else require(p[i] >= 32 && p[i] != 127 && std::wstring(L"/:<>\"|?*").find(p[i]) == std::wstring::npos);
    }
    const auto volume = p.substr(0,3);
    require(GetDriveTypeW(volume.c_str()) == DRIVE_FIXED);
    wchar_t fs[32]{};
    require(GetVolumeInformationW(volume.c_str(), nullptr, 0, nullptr, nullptr, nullptr, fs, 32) != 0 && wcscmp(fs, L"NTFS") == 0);
    return p;
}
bool systemSid(PSID sid) { return IsWellKnownSid(sid, WinLocalSystemSid) != 0; }
bool adminSid(PSID sid) { return IsWellKnownSid(sid, WinBuiltinAdministratorsSid) != 0; }
bool installerSid(PSID sid) {
    PSID raw = nullptr;
    require(ConvertStringSidToSidW(L"S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464", &raw) != 0);
    Local value(raw);
    return EqualSid(sid, raw) != 0;
}
void security(HANDLE h, bool privateObject, bool ancestor = false, bool managedInheritance = false) {
    PSID owner = nullptr; PACL acl = nullptr; PSECURITY_DESCRIPTOR raw = nullptr;
    require(GetSecurityInfo(h, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION, &owner, nullptr, &acl, nullptr, &raw) == ERROR_SUCCESS);
    Local descriptor(raw);
    require(owner && acl && IsValidSecurityDescriptor(raw) && IsValidAcl(acl));
    require(EqualSid(owner, userSid()) || (!privateObject && (systemSid(owner) || adminSid(owner) || installerSid(owner))));
    SECURITY_DESCRIPTOR_CONTROL control{}; DWORD revision = 0;
    require(GetSecurityDescriptorControl(raw, &control, &revision) != 0);
    if (privateObject) require((managedInheritance || (control & SE_DACL_PROTECTED) != 0) && EqualSid(owner, userSid()));
    for (DWORD index = 0; index < acl->AceCount; ++index) {
        void* rawAce = nullptr; require(GetAce(acl, index, &rawAce) != 0);
        auto* header = static_cast<ACE_HEADER*>(rawAce);
        require(header->AceType == ACCESS_ALLOWED_ACE_TYPE || header->AceType == ACCESS_DENIED_ACE_TYPE);
        auto* ace = static_cast<ACCESS_ALLOWED_ACE*>(rawAce);
        PSID sid = &ace->SidStart;
        require(IsValidSid(sid) != 0);
        if (privateObject && !managedInheritance) require((header->AceFlags & INHERITED_ACE) == 0);
        if (!privateObject && (header->AceFlags & INHERIT_ONLY_ACE)) continue;
        if (header->AceType == ACCESS_DENIED_ACE_TYPE) continue;
        if (EqualSid(sid, userSid()) || systemSid(sid)) continue;
        if (!privateObject && (adminSid(sid) || installerSid(sid))) continue;
        if (privateObject) require(ace->Mask == 0);
        else {
            DWORD mutation = FILE_WRITE_DATA | FILE_APPEND_DATA | FILE_WRITE_EA | FILE_WRITE_ATTRIBUTES | FILE_DELETE_CHILD | DELETE | WRITE_DAC | WRITE_OWNER | GENERIC_WRITE | GENERIC_ALL;
            // Shared ancestors may grant creation of a new sibling directory, never
            // modification/deletion of this already-open path's existing children.
            if (ancestor) mutation &= ~FILE_ADD_SUBDIRECTORY;
            require((ace->Mask & mutation) == 0);
        }
    }
}
BY_HANDLE_FILE_INFORMATION inspect(HANDLE h, bool directory, bool privateObject, bool ancestor = false, bool managedInheritance = false) {
    require(h && h != INVALID_HANDLE_VALUE && GetFileType(h) == FILE_TYPE_DISK);
    FILE_ATTRIBUTE_TAG_INFO tag{};
    require(GetFileInformationByHandleEx(h, FileAttributeTagInfo, &tag, sizeof(tag)) != 0);
    require(!(tag.FileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DEVICE | FILE_ATTRIBUTE_OFFLINE)));
    require(((tag.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0) == directory);
    BY_HANDLE_FILE_INFORMATION info{};
    require(GetFileInformationByHandle(h, &info) != 0 && (directory || info.nNumberOfLinks == 1));
    security(h, privateObject, ancestor, managedInheritance);
    return info;
}
void canonicalHandle(HANDLE h, const std::wstring& expected) {
    std::array<wchar_t, 8192> name{};
    DWORD length = GetFinalPathNameByHandleW(h, name.data(), static_cast<DWORD>(name.size()), FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
    require(length > 4 && length < name.size() && wcsncmp(name.data(), L"\\\\?\\", 4) == 0);
    require(CompareStringOrdinal(name.data() + 4, static_cast<int>(length - 4), expected.data(), static_cast<int>(expected.size()), TRUE) == CSTR_EQUAL);
}
void requirePrivateInheritance(HANDLE h) {
    security(h, true); PACL acl = nullptr; PSECURITY_DESCRIPTOR raw = nullptr;
    require(GetSecurityInfo(h, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, nullptr, nullptr, &acl, nullptr, &raw) == ERROR_SUCCESS);
    Local descriptor(raw); bool user = false, system = false;
    for (DWORD i = 0; i < acl->AceCount; ++i) {
        void* rawAce = nullptr; require(GetAce(acl, i, &rawAce) != 0);
        const auto* ace = static_cast<ACCESS_ALLOWED_ACE*>(rawAce);
        if (ace->Header.AceType != ACCESS_ALLOWED_ACE_TYPE || (ace->Header.AceFlags & (OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE)) != (OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE)) continue;
        auto sid = const_cast<DWORD*>(&ace->SidStart);
        if ((ace->Mask & FILE_ALL_ACCESS) != FILE_ALL_ACCESS) continue;
        user = user || EqualSid(sid, userSid()); system = system || systemSid(sid);
    }
    require(user && system);
}
Handle openObject(const std::wstring& p, bool directory, DWORD access = GENERIC_READ | READ_CONTROL, DWORD sharing = FILE_SHARE_READ) {
    Handle h(CreateFileW(p.c_str(), access, sharing, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT | (directory ? FILE_FLAG_BACKUP_SEMANTICS : 0), nullptr));
    require(h.value != INVALID_HANDLE_VALUE); canonicalHandle(h.value, p); return h;
}
std::vector<Handle> ancestors(const std::wstring& p) {
    std::vector<Handle> handles;
    auto volume = openObject(p.substr(0,3), true, READ_CONTROL | FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE);
    inspect(volume.value, true, false, true); handles.push_back(std::move(volume));
    for (size_t index = p.find(L'\\', 3); index != std::wstring::npos; index = p.find(L'\\', index + 1)) {
        auto h = openObject(p.substr(0,index), true, READ_CONTROL | FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE);
        inspect(h.value, true, false, true); handles.push_back(std::move(h));
    }
    return handles;
}
struct PrivateSecurity {
    Local descriptor;
    SECURITY_ATTRIBUTES attributes{ sizeof(SECURITY_ATTRIBUTES), nullptr, FALSE };
    explicit PrivateSecurity(bool inherit = false) {
        LPWSTR sid = nullptr; require(ConvertSidToStringSidW(userSid(), &sid) != 0); Local s(sid);
        const std::wstring flags = inherit ? L"OICI" : L"";
        auto text = std::wstring(L"O:") + sid + L"D:P(A;" + flags + L";FA;;;" + sid + L")(A;" + flags + L";FA;;;SY)";
        PSECURITY_DESCRIPTOR raw = nullptr;
        require(ConvertStringSecurityDescriptorToSecurityDescriptorW(text.c_str(), SDDL_REVISION_1, &raw, nullptr) != 0);
        descriptor.reset(raw); attributes.lpSecurityDescriptor = raw;
    }
};
bool same(const BY_HANDLE_FILE_INFORMATION& a, const BY_HANDLE_FILE_INFORMATION& b) {
    return a.dwVolumeSerialNumber == b.dwVolumeSerialNumber && a.nFileIndexHigh == b.nFileIndexHigh && a.nFileIndexLow == b.nFileIndexLow && a.nFileSizeHigh == b.nFileSizeHigh && a.nFileSizeLow == b.nFileSizeLow && a.ftLastWriteTime.dwHighDateTime == b.ftLastWriteTime.dwHighDateTime && a.ftLastWriteTime.dwLowDateTime == b.ftLastWriteTime.dwLowDateTime;
}
size_t inputBytes = 0;
size_t inputMaximum = 16 * 1024 * 1024 + 16392;
void readExact(void* target, size_t length) {
    require(inputBytes <= inputMaximum && length <= inputMaximum - inputBytes);
    inputBytes += length;
    require(length == 0 || fread(target, 1, length, stdin) == length);
}
uint32_t number() { std::array<unsigned char,4> b{}; readExact(b.data(), b.size()); return (uint32_t(b[0]) << 24) | (uint32_t(b[1]) << 16) | (uint32_t(b[2]) << 8) | b[3]; }
std::string field(size_t maximum) { auto n = number(); require(n <= maximum); std::string value(n, '\0'); readExact(value.data(), n); return value; }
void output(const void* bytes, size_t n) { require(n == 0 || fwrite(bytes, 1, n, stdout) == n); require(fflush(stdout) == 0); }
void json(const std::string& value) {
    require(value.size() <= 4096); auto n = static_cast<uint32_t>(value.size());
    std::array<unsigned char,4> b{static_cast<unsigned char>(n >> 24),static_cast<unsigned char>(n >> 16),static_cast<unsigned char>(n >> 8),static_cast<unsigned char>(n)};
    output(b.data(), b.size()); output(value.data(), value.size());
}
void writeAll(HANDLE h, const unsigned char* bytes, size_t size) {
    size_t offset = 0;
    while (offset < size) { DWORD n = 0; require(WriteFile(h, bytes + offset, static_cast<DWORD>(size - offset), &n, nullptr) && n); offset += n; }
    require(FlushFileBuffers(h) != 0);
}
Secret readProtected(const std::wstring& p, bool privateObject, uint32_t maximum) {
    require(maximum > 0 && maximum <= 16 * 1024 * 1024);
    auto chain = ancestors(p); auto h = openObject(p, false);
    auto before = inspect(h.value, false, privateObject);
    require(before.nFileSizeHigh == 0 && before.nFileSizeLow > 0 && before.nFileSizeLow <= maximum);
    Secret bytes; bytes.data.resize(before.nFileSizeLow);
    size_t offset = 0;
    while (offset < bytes.data.size()) { DWORD n = 0; require(ReadFile(h.value, bytes.data.data() + offset, static_cast<DWORD>(bytes.data.size() - offset), &n, nullptr) && n); offset += n; }
    require(same(before, inspect(h.value, false, privateObject)));
    for (const auto& ancestor : chain) inspect(ancestor.value, true, false, true);
    return bytes;
}
void createDirectory(const std::wstring& p, bool inherit = false) {
    auto chain = ancestors(p); PrivateSecurity sec(inherit);
    if (!CreateDirectoryW(p.c_str(), &sec.attributes)) require(GetLastError() == ERROR_ALREADY_EXISTS);
    auto h = openObject(p, true, READ_CONTROL | FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE);
    inspect(h.value, true, true);
    if (inherit) requirePrivateInheritance(h.value);
}
void writeFresh(const std::wstring& p, const Secret& bytes) {
    auto chain = ancestors(p); require(!chain.empty()); inspect(chain.back().value, true, true);
    PrivateSecurity sec;
    Handle file(CreateFileW(p.c_str(), GENERIC_READ | GENERIC_WRITE | READ_CONTROL, 0, &sec.attributes, CREATE_NEW, FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_WRITE_THROUGH, nullptr));
    inspect(file.value, false, true); writeAll(file.value, bytes.data.data(), bytes.data.size()); inspect(file.value, false, true);
    // A failed fresh publication is intentionally retained: enrollment must not
    // reinterpret a partial file as absent and generate a replacement identity.
}
void replacePrivate(const std::wstring& p, const Secret& bytes) {
    auto chain = ancestors(p); inspect(chain.back().value, true, true);
    const auto pending = p + L".pending";
    // The fixed sidecar is recovery evidence. Never remove/reuse it on startup.
    // An interrupted replacement fails closed until higher-level authenticated
    // recovery decides which generation is valid; atomicity is not durability.
    require(GetFileAttributesW(pending.c_str()) == INVALID_FILE_ATTRIBUTES && GetLastError() == ERROR_FILE_NOT_FOUND);
    auto old = openObject(p, false, GENERIC_READ | READ_CONTROL, FILE_SHARE_READ | FILE_SHARE_DELETE);
    inspect(old.value, false, true);
    writeFresh(pending, bytes);
    require(ReplaceFileW(p.c_str(), pending.c_str(), nullptr, 0, nullptr, nullptr) != 0);
    auto current = openObject(p, false, GENERIC_READ | GENERIC_WRITE | READ_CONTROL);
    inspect(current.value, false, true); require(FlushFileBuffers(current.value) != 0);
}
#include "owner-lease.inc"
#include "owned-process.inc"
#include "storage-session.inc"
#include "unix-server.inc"
}

int wmain(int argc, wchar_t** argv) {
    try {
        initialize(); require(argc == 2);
        std::wstring op(argv[1]);
        if (op == L"lease") { lease(); return 0; }
        if (op == L"managed") { inputMaximum = 256 * 1024; managedProcess(); return 0; }
        if (op == L"storage") { storageSession(); return 0; }
        if (op == L"unix-server") { unixServer(); return 0; }
        auto p = checkedPath(wide(field(16384)));
        if (op == L"read-private" || op == L"read-public") { auto bytes = readProtected(p, op == L"read-private", number()); output(bytes.data.data(), bytes.data.size()); }
        else if (op == L"mkdir" || op == L"mkdir-inherited") createDirectory(p, op == L"mkdir-inherited");
        else if (op == L"rmdir-private") {
            const auto expected = field(256); auto chain = ancestors(p);
            auto h = openObject(p, true, READ_CONTROL | FILE_READ_ATTRIBUTES | DELETE, FILE_SHARE_READ | FILE_SHARE_WRITE);
            const auto info = inspect(h.value, true, true);
            require(expected == "WI1:" + std::to_string(info.dwVolumeSerialNumber) + ":" + std::to_string(info.nFileIndexHigh) + ":" + std::to_string(info.nFileIndexLow));
            FILE_DISPOSITION_INFO disposition{TRUE}; require(SetFileInformationByHandle(h.value, FileDispositionInfo, &disposition, sizeof(disposition)) != 0);
        }
        else if (op == L"inspect-private-directory" || op == L"inspect-private" || op == L"inspect-public") {
            bool dir = op == L"inspect-private-directory"; auto chain = ancestors(p);
            auto h = openObject(p, dir, READ_CONTROL | FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE);
            auto info = inspect(h.value, dir, op != L"inspect-public");
            std::string result = std::to_string(info.dwVolumeSerialNumber) + ":" + std::to_string(info.nFileIndexHigh) + ":" + std::to_string(info.nFileIndexLow);
            output(result.data(), result.size());
        } else if (op == L"write-fresh" || op == L"replace-private") {
            auto n = number(); require(n > 0 && n <= 16 * 1024 * 1024); Secret bytes; bytes.data.resize(n); readExact(bytes.data.data(), n);
            if (op == L"write-fresh") writeFresh(p, bytes); else replacePrivate(p, bytes);
        } else fail();
        return 0;
    } catch (...) { return 3; }
}
