constexpr uint32_t STORAGE_CHUNK = 1024 * 1024;
constexpr uint64_t STORAGE_LIMIT = 9007199254740991ULL;
uint64_t fileTime(FILETIME value) { return (uint64_t(value.dwHighDateTime) << 32) | value.dwLowDateTime; }
std::string utf8(const std::wstring& value) {
    if (value.empty()) return {};
    int size = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
    require(size > 0); std::string result(static_cast<size_t>(size), '\0');
    require(WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), result.data(), size, nullptr, nullptr) == size);
    return result;
}
std::string quoted(const std::string& value) {
    std::string result; result.reserve(value.size() + 2); result.push_back('"');
    constexpr char hex[] = "0123456789abcdef";
    for (unsigned char c : value) {
        if (c == '"' || c == '\\') { result.push_back('\\'); result.push_back(static_cast<char>(c)); }
        else if (c < 32) { result += "\\u00"; result.push_back(hex[c >> 4]); result.push_back(hex[c & 15]); }
        else result.push_back(static_cast<char>(c));
    }
    result.push_back('"'); return result;
}
std::string ownerText(HANDLE handle) {
    PSID owner = nullptr; PSECURITY_DESCRIPTOR raw = nullptr;
    require(GetSecurityInfo(handle, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION, &owner, nullptr, nullptr, nullptr, &raw) == ERROR_SUCCESS);
    Local descriptor(raw); LPWSTR text = nullptr;
    require(owner && ConvertSidToStringSidW(owner, &text) != 0); Local allocated(text);
    return utf8(text);
}
uint64_t storageNumber() {
    const auto value = field(16); require(!value.empty() && (value.size() == 1 || value.front() != '0'));
    uint64_t result = 0;
    for (char c : value) { require(c >= '0' && c <= '9'); result = result * 10 + static_cast<unsigned>(c - '0'); require(result <= STORAGE_LIMIT); }
    return result;
}
struct StorageState {
    bool directory = false;
    uint64_t size = 0, allocationSize = 0;
    std::string volume, fileId, owner, modified, changed;
    std::string identity() const { return "WI1:" + volume + ":" + fileId; }
    std::string token() const { return "WS1:" + volume + ":" + fileId + ":" + std::to_string(size) + ":" + std::to_string(allocationSize) + ":" + modified + ":" + changed; }
    std::string jsonValue() const {
        return "{\"format\":1,\"platform\":\"win32\",\"kind\":" + quoted(directory ? "directory" : "file")
            + ",\"volume\":" + quoted(volume) + ",\"fileId\":" + quoted(fileId) + ",\"owner\":" + quoted(owner)
            + ",\"size\":" + quoted(std::to_string(size)) + ",\"allocationSize\":" + quoted(std::to_string(allocationSize)) + ",\"modified\":" + quoted(modified) + ",\"changed\":" + quoted(changed)
            + ",\"identity\":" + quoted(identity()) + ",\"token\":" + quoted(token()) + "}";
    }
};
StorageState storageState(HANDLE handle, bool directory, bool privateObject, bool managed = false) {
    const auto info = inspect(handle, directory, privateObject, false, managed);
    FILE_BASIC_INFO basic{}; require(GetFileInformationByHandleEx(handle, FileBasicInfo, &basic, sizeof(basic)) != 0);
    FILE_STANDARD_INFO standard{}; require(GetFileInformationByHandleEx(handle, FileStandardInfo, &standard, sizeof(standard)) != 0);
    require(standard.AllocationSize.QuadPart >= 0);
    StorageState result;
    result.directory = directory; result.size = (uint64_t(info.nFileSizeHigh) << 32) | info.nFileSizeLow;
    result.allocationSize = static_cast<uint64_t>(standard.AllocationSize.QuadPart);
    require(result.size <= STORAGE_LIMIT && basic.ChangeTime.QuadPart >= 0);
    result.volume = std::to_string(info.dwVolumeSerialNumber);
    result.fileId = std::to_string(info.nFileIndexHigh) + ":" + std::to_string(info.nFileIndexLow);
    result.owner = ownerText(handle); result.modified = std::to_string(fileTime(info.ftLastWriteTime));
    result.changed = std::to_string(static_cast<uint64_t>(basic.ChangeTime.QuadPart));
    return result;
}
void expectedState(const StorageState& state, const std::string& expected, bool required = false) {
    require(!required || !expected.empty());
    require(expected.empty() || expected == state.token() || expected == state.identity());
}
void storageJson(const std::string& value) {
    require(value.size() <= 256 * 1024); const auto size = static_cast<uint32_t>(value.size());
    const std::array<unsigned char,4> header{static_cast<unsigned char>(size >> 24), static_cast<unsigned char>(size >> 16), static_cast<unsigned char>(size >> 8), static_cast<unsigned char>(size)};
    output(header.data(), header.size()); output(value.data(), value.size());
}
void filePosition(HANDLE handle, uint64_t offset) {
    require(offset <= STORAGE_LIMIT); LARGE_INTEGER position{}; position.QuadPart = static_cast<LONGLONG>(offset);
    require(SetFilePointerEx(handle, position, nullptr, FILE_BEGIN) != 0);
}
void readFileExact(HANDLE handle, unsigned char* bytes, size_t length) {
    size_t offset = 0;
    while (offset < length) { DWORD count = 0; require(ReadFile(handle, bytes + offset, static_cast<DWORD>(length - offset), &count, nullptr) && count); offset += count; }
}
struct StorageFile {
    Handle handle;
    std::vector<Handle> parents;
    StorageState initial;
    std::string mode;
    Secret marker;
    uint64_t position = 0, maximum = 0;
    bool enumerationStarted = false, enumerationEnded = false;
};
void checkStorageLock(StorageFile& entry, bool managed, unsigned char* scratch) {
    require(entry.mode == "lock");
    auto before = storageState(entry.handle.value, false, true, managed);
    require(before.token() == entry.initial.token() && before.size == entry.marker.data.size());
    filePosition(entry.handle.value, 0); readFileExact(entry.handle.value, scratch, entry.marker.data.size());
    require(memcmp(scratch, entry.marker.data.data(), entry.marker.data.size()) == 0);
    SecureZeroMemory(scratch, entry.marker.data.size());
    require(storageState(entry.handle.value, false, true, managed).token() == before.token());
}
void storageSession() {
    inputMaximum = STORAGE_CHUNK + 65536; inputBytes = 0;
    const auto root = checkedPath(wide(field(16384)));
    const auto scope = field(16); require(scope == "private" || scope == "workspace" || scope == "source");
    const bool privateObject = scope != "source", managed = scope == "workspace";
    auto rootParents = ancestors(root);
    auto rootHandle = openObject(root, true, READ_CONTROL | FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE);
    const auto rootIdentity = storageState(rootHandle.value, true, privateObject).identity();
    if (managed) requirePrivateInheritance(rootHandle.value);
    auto verifyRoot = [&]() {
        for (const auto& parent : rootParents) inspect(parent.value, true, false, true);
        require(storageState(rootHandle.value, true, privateObject).identity() == rootIdentity);
        if (managed) requirePrivateInheritance(rootHandle.value);
    };
    auto resolve = [&](const std::string& relative, bool rootAllowed = false) {
        require((rootAllowed || !relative.empty()) && relative.size() <= 16384);
        if (relative.empty()) return root;
        auto suffix = wide(relative); std::replace(suffix.begin(), suffix.end(), L'/', L'\\');
        return checkedPath(root + L"\\" + suffix);
    };
    uint32_t sequence = 0, nextHandle = 0;
    std::unordered_map<uint32_t, StorageFile> files;
    Secret bytes; bytes.data.resize(STORAGE_CHUNK);
    Secret verification; verification.data.resize(65536);
    auto& readback = verification.data;
    storageJson("{\"seq\":0,\"state\":" + storageState(rootHandle.value, true, privateObject).jsonValue() + "}");
    for (;;) {
        const int first = fgetc(stdin); if (first == EOF) return;
        require(ungetc(first, stdin) != EOF); inputBytes = 0;
        const auto operation = field(32); const auto request = number();
        require(sequence != UINT32_MAX && request == ++sequence); verifyRoot();
        std::string result = "{\"seq\":" + std::to_string(sequence); size_t outputBytes = 0, usedBytes = 0;
        if (operation == "close") { require(files.empty()); storageJson(result + "}"); return; }
        if (operation == "stat") {
            const auto file = resolve(field(16384), true); const bool directory = number() != 0, missing = number() != 0;
            auto parents = ancestors(file);
            Handle handle(CreateFileW(filesystemPath(file).c_str(), READ_CONTROL | FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE,
                nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT | (directory ? FILE_FLAG_BACKUP_SEMANTICS : 0), nullptr));
            if (handle.value == INVALID_HANDLE_VALUE) { require(missing && GetLastError() == ERROR_FILE_NOT_FOUND); result += ",\"state\":null"; }
            else { canonicalHandle(handle.value, file); result += ",\"state\":" + storageState(handle.value, directory, privateObject, managed && file != root).jsonValue(); }
        } else if (operation == "mkdir") {
            require(privateObject); const auto file = resolve(field(16384)); const bool inherit = number() != 0;
            auto parents = ancestors(file); PrivateSecurity descriptor(inherit);
            require(CreateDirectoryW(filesystemPath(file).c_str(), &descriptor.attributes) != 0);
            auto handle = openObject(file, true, READ_CONTROL | FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE);
            if (inherit) requirePrivateInheritance(handle.value);
            result += ",\"state\":" + storageState(handle.value, true, true).jsonValue();
        } else if (operation == "lock") {
            require(privateObject && files.size() < 64 && nextHandle != UINT32_MAX);
            const auto file = resolve(field(16384)); const auto length = number(); require(length > 0 && length <= 4096);
            StorageFile entry; entry.parents = ancestors(file); entry.mode = "lock"; entry.marker.data.resize(length);
            readExact(entry.marker.data.data(), length); PrivateSecurity descriptor;
            entry.handle = Handle(CreateFileW(filesystemPath(file).c_str(), GENERIC_READ | GENERIC_WRITE | READ_CONTROL, FILE_SHARE_READ | FILE_SHARE_WRITE,
                &descriptor.attributes, CREATE_NEW, FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_WRITE_THROUGH, nullptr));
            const bool fresh = entry.handle.value != INVALID_HANDLE_VALUE;
            if (!fresh) { require(GetLastError() == ERROR_FILE_EXISTS); entry.handle = Handle(CreateFileW(filesystemPath(file).c_str(), GENERIC_READ | GENERIC_WRITE | READ_CONTROL,
                FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_WRITE_THROUGH, nullptr)); }
            canonicalHandle(entry.handle.value, file); inspect(entry.handle.value, false, true, false, managed);
            OVERLAPPED position{}; require(LockFileEx(entry.handle.value, LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, &position) != 0);
            if (fresh) writeAll(entry.handle.value, entry.marker.data.data(), entry.marker.data.size());
            entry.initial = storageState(entry.handle.value, false, true, managed); checkStorageLock(entry, managed, readback.data());
            const auto handleId = ++nextHandle; result += ",\"handle\":" + std::to_string(handleId) + ",\"state\":" + entry.initial.jsonValue();
            files.emplace(handleId, std::move(entry));
        } else if (operation == "open") {
            require(files.size() < 64 && nextHandle != UINT32_MAX);
            const auto file = resolve(field(16384), true); const auto mode = field(16); const auto expected = field(256); const auto maximum = storageNumber();
            const bool directory = mode == "directory", writing = mode == "create" || mode == "append" || mode == "slot";
            require(directory || writing || mode == "read"); require(!writing || (privateObject && file != root));
            require(mode == "create" ? expected.empty() : !writing || !expected.empty());
            require(!writing || mode == "create" || expected.rfind("WS1:", 0) == 0);
            StorageFile entry; entry.parents = ancestors(file); entry.mode = mode; entry.maximum = maximum;
            PrivateSecurity descriptor;
            entry.handle = Handle(CreateFileW(filesystemPath(file).c_str(), READ_CONTROL | GENERIC_READ | (writing ? GENERIC_WRITE : 0),
                FILE_SHARE_READ, mode == "create" ? &descriptor.attributes : nullptr, mode == "create" ? CREATE_NEW : OPEN_EXISTING,
                FILE_FLAG_OPEN_REPARSE_POINT | (directory ? FILE_FLAG_BACKUP_SEMANTICS : 0) | (writing ? FILE_FLAG_WRITE_THROUGH : 0), nullptr));
            canonicalHandle(entry.handle.value, file);
            entry.initial = storageState(entry.handle.value, directory, privateObject, managed && file != root);
            expectedState(entry.initial, expected, writing && mode != "create");
            require(directory || entry.initial.size <= maximum);
            if (mode == "append") entry.position = entry.initial.size;
            const auto handleId = ++nextHandle;
            result += ",\"handle\":" + std::to_string(handleId) + ",\"state\":" + entry.initial.jsonValue();
            files.emplace(handleId, std::move(entry));
        } else if (operation == "read" || operation == "write" || operation == "commit" || operation == "release" || operation == "next" || operation == "check-lock") {
            const auto handleId = number(); const auto found = files.find(handleId); require(found != files.end()); auto& entry = found->second;
            for (const auto& parent : entry.parents) inspect(parent.value, true, false, true);
            if (operation == "release") { files.erase(found); }
            else if (operation == "check-lock") { checkStorageLock(entry, managed, readback.data()); result += ",\"state\":" + storageState(entry.handle.value, false, true, managed).jsonValue(); }
            else if (operation == "read") {
                require(entry.mode == "read"); const auto offset = storageNumber(); const auto count = number(); require(count > 0 && count <= STORAGE_CHUNK);
                const auto before = storageState(entry.handle.value, false, privateObject, managed);
                require(before.token() == entry.initial.token() && offset <= before.size);
                outputBytes = static_cast<size_t>(std::min<uint64_t>(count, before.size - offset)); usedBytes = outputBytes;
                filePosition(entry.handle.value, offset); readFileExact(entry.handle.value, bytes.data.data(), outputBytes);
                require(storageState(entry.handle.value, false, privateObject, managed).token() == before.token());
                result += ",\"bytes\":" + std::to_string(outputBytes);
            } else if (operation == "write") {
                require(entry.mode == "create" || entry.mode == "append" || entry.mode == "slot"); const auto count = number();
                require(count > 0 && count <= STORAGE_CHUNK && entry.position <= entry.maximum && count <= entry.maximum - entry.position);
                usedBytes = count; readExact(bytes.data.data(), count);
                inspect(entry.handle.value, false, true, false, managed);
                filePosition(entry.handle.value, entry.position); writeAll(entry.handle.value, bytes.data.data(), count);
                filePosition(entry.handle.value, entry.position);
                for (size_t offset = 0; offset < count;) {
                    const auto length = std::min(readback.size(), static_cast<size_t>(count) - offset);
                    readFileExact(entry.handle.value, readback.data(), length);
                    require(memcmp(readback.data(), bytes.data.data() + offset, length) == 0);
                    SecureZeroMemory(readback.data(), length); offset += length;
                }
                entry.position += count; result += ",\"position\":" + quoted(std::to_string(entry.position));
            } else if (operation == "commit") {
                require(entry.mode == "create" || entry.mode == "append" || entry.mode == "slot");
                filePosition(entry.handle.value, entry.position);
                if (entry.mode == "slot") require(SetEndOfFile(entry.handle.value) != 0);
                // NTFS may defer write/change timestamps until the writing handle
                // closes. Commit must return a token that survives that close.
                if (entry.mode != "append" || entry.position != entry.initial.size) {
                    // Remove speculative allocation while the exclusive writer
                    // and retained parents are still held; closing must not
                    // change the allocation component of the acknowledged WS1.
                    FILE_ALLOCATION_INFO allocation{};
                    allocation.AllocationSize.QuadPart = static_cast<LONGLONG>(entry.position);
                    require(SetFileInformationByHandle(entry.handle.value, FileAllocationInfo, &allocation, sizeof(allocation)) != 0);
                    FILETIME now{}; GetSystemTimeAsFileTime(&now);
                    FILE_BASIC_INFO times{};
                    times.LastWriteTime.QuadPart = times.ChangeTime.QuadPart = static_cast<LONGLONG>(fileTime(now));
                    require(SetFileInformationByHandle(entry.handle.value, FileBasicInfo, &times, sizeof(times)) != 0);
                    times.LastWriteTime.QuadPart = times.ChangeTime.QuadPart = -1;
                    require(SetFileInformationByHandle(entry.handle.value, FileBasicInfo, &times, sizeof(times)) != 0);
                }
                require(FlushFileBuffers(entry.handle.value) != 0);
                const auto state = storageState(entry.handle.value, false, true, managed); require(state.size == entry.position);
                result += ",\"state\":" + state.jsonValue(); files.erase(found);
            } else {
                require(entry.mode == "directory");
                require(storageState(entry.handle.value, true, privateObject, managed).token() == entry.initial.token());
                std::string names = "["; bool firstName = true;
                if (!entry.enumerationEnded) {
                    const auto kind = entry.enumerationStarted ? FileIdBothDirectoryInfo : FileIdBothDirectoryRestartInfo;
                    if (!GetFileInformationByHandleEx(entry.handle.value, kind, bytes.data.data(), 65536)) {
                        require(GetLastError() == ERROR_NO_MORE_FILES); entry.enumerationEnded = true;
                    } else {
                        usedBytes = 65536; size_t offset = 0;
                        for (;;) {
                            require(offset + offsetof(FILE_ID_BOTH_DIR_INFO, FileName) <= 65536);
                            const auto* item = reinterpret_cast<const FILE_ID_BOTH_DIR_INFO*>(bytes.data.data() + offset);
                            require(item->FileNameLength % sizeof(wchar_t) == 0 && item->FileNameLength <= 65536 - offset - offsetof(FILE_ID_BOTH_DIR_INFO, FileName));
                            std::wstring name(item->FileName, item->FileNameLength / sizeof(wchar_t));
                            if (name != L"." && name != L"..") {
                                require(!(item->FileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DEVICE | FILE_ATTRIBUTE_OFFLINE)));
                                if (!firstName) names.push_back(','); firstName = false;
                                names += "{\"name\":" + quoted(utf8(name)) + ",\"directory\":" + ((item->FileAttributes & FILE_ATTRIBUTE_DIRECTORY) ? "true" : "false") + "}";
                            }
                            if (!item->NextEntryOffset) break;
                            require(item->NextEntryOffset >= offsetof(FILE_ID_BOTH_DIR_INFO, FileName) && item->NextEntryOffset <= 65536 - offset);
                            offset += item->NextEntryOffset;
                        }
                    }
                    entry.enumerationStarted = true;
                }
                require(storageState(entry.handle.value, true, privateObject, managed).token() == entry.initial.token());
                result += ",\"entries\":" + names + "],\"end\":" + (entry.enumerationEnded ? "true" : "false");
            }
        } else if (operation == "remove" || operation == "rename") {
            require(privateObject); const auto file = resolve(field(16384)); const bool directory = number() != 0; const auto expected = field(256);
            auto parents = ancestors(file);
            auto handle = openObject(file, directory, DELETE | READ_CONTROL | FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE);
            expectedState(storageState(handle.value, directory, true, managed), expected, true);
            if (operation == "remove") {
                FILE_DISPOSITION_INFO disposition{}; disposition.DeleteFile = TRUE;
                require(SetFileInformationByHandle(handle.value, FileDispositionInfo, &disposition, sizeof(disposition)) != 0);
            } else {
                const auto destination = resolve(field(16384)); auto destinationParents = ancestors(destination);
                const auto destinationPath = filesystemPath(destination);
                const size_t nameBytes = destinationPath.size() * sizeof(wchar_t);
                // FileNameLength excludes the terminator; Win32 FILE_RENAME_INFO
                // also specifies a NUL-terminated FileName.
                std::vector<unsigned char> storage(offsetof(FILE_RENAME_INFO, FileName) + nameBytes + sizeof(wchar_t));
                auto* rename = reinterpret_cast<FILE_RENAME_INFO*>(storage.data());
                rename->ReplaceIfExists = FALSE; rename->RootDirectory = nullptr; rename->FileNameLength = static_cast<DWORD>(nameBytes);
                memcpy(rename->FileName, destinationPath.data(), nameBytes);
                require(SetFileInformationByHandle(handle.value, FileRenameInfo, rename, static_cast<DWORD>(storage.size())) != 0);
                result += ",\"state\":" + storageState(handle.value, directory, true, managed).jsonValue();
            }
            // Namespace mutation is not an authenticated durable commit. Callers
            // reconcile immutable identities and receipt records before reuse.
        } else if (operation == "capacity") {
            ULARGE_INTEGER available{}, total{}, free{};
            require(GetDiskFreeSpaceExW(filesystemPath(root).c_str(), &available, &total, &free) != 0);
            result += ",\"available\":" + quoted(std::to_string(available.QuadPart)) + ",\"total\":" + quoted(std::to_string(total.QuadPart));
        } else fail();
        verifyRoot(); storageJson(result + "}");
        if (outputBytes) output(bytes.data.data(), outputBytes);
        if (usedBytes) SecureZeroMemory(bytes.data.data(), usedBytes);
    }
}
