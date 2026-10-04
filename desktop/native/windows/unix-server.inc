// Included inside boundary.cpp's namespace, after the checked filesystem helpers.
// winsock2.h must precede windows.h; afunix.h and ws2_32 are required.
struct UnixSocket {
    SOCKET value = INVALID_SOCKET;
    explicit UnixSocket(SOCKET socket = INVALID_SOCKET) : value(socket) {}
    ~UnixSocket() { if (value != INVALID_SOCKET) closesocket(value); }
    UnixSocket(UnixSocket&& other) noexcept : value(other.value) { other.value = INVALID_SOCKET; }
    UnixSocket(const UnixSocket&) = delete;
};
uint32_t unixNumber(const unsigned char* bytes) {
    return (uint32_t(bytes[0]) << 24) | (uint32_t(bytes[1]) << 16) | (uint32_t(bytes[2]) << 8) | bytes[3];
}
void unixEvent(unsigned char type, uint32_t id, const std::vector<unsigned char>& body = {}) {
    const auto n = static_cast<uint32_t>(body.size() + 5);
    const std::array<unsigned char, 9> head{static_cast<unsigned char>(n >> 24), static_cast<unsigned char>(n >> 16),
        static_cast<unsigned char>(n >> 8), static_cast<unsigned char>(n), type,
        static_cast<unsigned char>(id >> 24), static_cast<unsigned char>(id >> 16),
        static_cast<unsigned char>(id >> 8), static_cast<unsigned char>(id)};
    output(head.data(), head.size()); output(body.data(), body.size());
}
BY_HANDLE_FILE_INFORMATION unixLeaf(HANDLE h, const std::wstring& path) {
    canonicalHandle(h, path);
    FILE_ATTRIBUTE_TAG_INFO tag{}; BY_HANDLE_FILE_INFORMATION info{};
    require(GetFileInformationByHandleEx(h, FileAttributeTagInfo, &tag, sizeof(tag)) != 0);
    // Only this owned socket leaf may be AF_UNIX. All ancestors still use inspect().
    require((tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) && tag.ReparseTag == 0x80000023
        && !(tag.FileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_DEVICE | FILE_ATTRIBUTE_OFFLINE)));
    require(GetFileInformationByHandle(h, &info) && info.nNumberOfLinks == 1);
    security(h, true); return info;
}
struct UnixPeer {
    UnixSocket socket;
    Secret request;
    Secret response;
    size_t sent = 0;
    ULONGLONG deadline;
    bool dispatched = false;
    explicit UnixPeer(SOCKET value, ULONGLONG until) : socket(value), deadline(until) {}
};
void unixServer() {
    const auto encoded = field(100);
    const auto socketPath = checkedPath(wide(encoded));
    const auto maxRequest = number(), maxResponse = number(), maxConnections = number(), frameTimeout = number();
    const auto absoluteDeadline = number(); require(absoluteDeadline <= 1);
    require(maxRequest >= 2 && maxRequest <= 3 * 1024 * 1024 && maxResponse >= 2 && maxResponse <= 4 * 1024 * 1024
        && maxConnections >= 1 && maxConnections <= 16 && frameTimeout >= 1 && frameTimeout <= 30000);
    auto chain = ancestors(socketPath);
    require(!chain.empty()); inspect(chain.back().value, true, true);
    require(GetFileAttributesW(socketPath.c_str()) == INVALID_FILE_ATTRIBUTES && GetLastError() == ERROR_FILE_NOT_FOUND);
    WSADATA wsa{}; require(WSAStartup(MAKEWORD(2, 2), &wsa) == 0);
    struct CleanupWinsock { ~CleanupWinsock() { WSACleanup(); } } cleanupWinsock;
    UnixSocket listener(socket(AF_UNIX, SOCK_STREAM, 0)); require(listener.value != INVALID_SOCKET);
    sockaddr_un address{}; address.sun_family = AF_UNIX;
    require(encoded.size() <= 100 && encoded.size() < sizeof(address.sun_path));
    memcpy(address.sun_path, encoded.data(), encoded.size());
    require(bind(listener.value, reinterpret_cast<sockaddr*>(&address), static_cast<int>(sizeof(address))) == 0);
    Handle leaf(CreateFileW(socketPath.c_str(), READ_CONTROL | WRITE_DAC | FILE_READ_ATTRIBUTES | DELETE,
        FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING,
        FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, nullptr));
    require(leaf.value != INVALID_HANDLE_VALUE);
    PrivateSecurity privateSecurity;
    BOOL present = FALSE, defaulted = FALSE; PACL acl = nullptr;
    require(GetSecurityDescriptorDacl(privateSecurity.descriptor.get(), &present, &acl, &defaulted) && present && acl);
    require(SetSecurityInfo(leaf.value, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
        nullptr, nullptr, acl, nullptr) == ERROR_SUCCESS);
    const auto identity = unixLeaf(leaf.value, socketPath);
    // The directory excludes other users before bind; the socket is private before listen/READY.
    require(listen(listener.value, static_cast<int>(maxConnections)) == 0);
    u_long nonblocking = 1; require(ioctlsocket(listener.value, FIONBIO, &nonblocking) == 0);
    unixEvent(1, 0);
    std::unordered_map<uint32_t, std::unique_ptr<UnixPeer>> peers;
    Secret input; uint32_t serial = 0; bool stop = false;
    const auto pipe = GetStdHandle(STD_INPUT_HANDLE);
    while (!stop) {
        DWORD available = 0;
        require(PeekNamedPipe(pipe, nullptr, 0, nullptr, &available, nullptr) != 0);
        if (available) {
            std::array<unsigned char, 65536> chunk{}; DWORD count = 0;
            require(ReadFile(pipe, chunk.data(), (std::min)(available, static_cast<DWORD>(chunk.size())), &count, nullptr) && count);
            input.data.insert(input.data.end(), chunk.begin(), chunk.begin() + count); SecureZeroMemory(chunk.data(), count);
            size_t offset = 0;
            while (input.data.size() - offset >= 4) {
                const auto length = unixNumber(input.data.data() + offset);
                require(length >= 5 && length <= maxResponse + 9);
                if (input.data.size() - offset < length + 4) break;
                const auto* message = input.data.data() + offset + 4;
                const auto type = message[0]; const auto id = unixNumber(message + 1); const auto bodyLength = length - 5;
                if (type == 3) { require(id == 0 && bodyLength == 0); stop = true; }
                else {
                    require((type == 1 || type == 2) && id > 0 && id <= serial);
                    auto found = peers.find(id);
                    if (type == 2) { require(bodyLength == 0); if (found != peers.end()) { peers.erase(found); unixEvent(3, id); } }
                    else {
                        require(bodyLength >= 6 && bodyLength <= maxResponse + 4 && unixNumber(message + 5) == bodyLength - 4);
                        // A client may expire between JS dispatch and response. Never reuse its id.
                        if (found != peers.end()) {
                            auto& peer = *found->second;
                            require(peer.dispatched && peer.response.data.empty());
                            peer.response.data.assign(message + 5, message + 5 + bodyLength);
                        }
                    }
                }
                offset += length + 4;
                if (stop) { require(offset == input.data.size()); break; }
            }
            if (offset) { SecureZeroMemory(input.data.data(), offset); input.data.erase(input.data.begin(), input.data.begin() + offset); }
            require(input.data.size() <= maxResponse + 13);
        }
        if (stop) break;
        fd_set reads, writes; FD_ZERO(&reads); FD_ZERO(&writes); FD_SET(listener.value, &reads);
        for (const auto& entry : peers) {
            if (!entry.second->dispatched) FD_SET(entry.second->socket.value, &reads);
            if (!entry.second->response.data.empty()) FD_SET(entry.second->socket.value, &writes);
        }
        timeval interval{0, 10000}; require(select(0, &reads, &writes, nullptr, &interval) != SOCKET_ERROR);
        if (FD_ISSET(listener.value, &reads)) {
            SOCKET accepted = accept(listener.value, nullptr, nullptr);
            if (accepted != INVALID_SOCKET) {
                if (peers.size() >= maxConnections || serial == UINT32_MAX) closesocket(accepted);
                else {
                    UnixSocket owned(accepted); require(ioctlsocket(accepted, FIONBIO, &nonblocking) == 0);
                    auto peer = std::make_unique<UnixPeer>(accepted, GetTickCount64() + frameTimeout); owned.value = INVALID_SOCKET;
                    peers.emplace(++serial, std::move(peer));
                }
            } else require(WSAGetLastError() == WSAEWOULDBLOCK);
        }
        for (auto it = peers.begin(); it != peers.end();) {
            auto& peer = *it->second; bool close = GetTickCount64() >= peer.deadline;
            if (!close && FD_ISSET(peer.socket.value, &reads)) {
                std::array<unsigned char, 65536> chunk{};
                const int count = recv(peer.socket.value, reinterpret_cast<char*>(chunk.data()), static_cast<int>(chunk.size()), 0);
                if (count == 0) {
                    if (peer.request.data.size() < 6 || unixNumber(peer.request.data.data()) != peer.request.data.size() - 4) close = true;
                    else {
                        peer.dispatched = true;
                        if (!absoluteDeadline) peer.deadline = GetTickCount64() + 90000;
                        unixEvent(2, it->first, peer.request.data);
                        SecureZeroMemory(peer.request.data.data(), peer.request.data.size()); peer.request.data.clear();
                    }
                } else if (count < 0) close = WSAGetLastError() != WSAEWOULDBLOCK;
                else {
                    if (peer.request.data.size() + count > maxRequest + 4) close = true;
                    else {
                        peer.request.data.insert(peer.request.data.end(), chunk.begin(), chunk.begin() + count);
                        if (peer.request.data.size() >= 4) {
                            const auto size = unixNumber(peer.request.data.data());
                            close = size < 2 || size > maxRequest || peer.request.data.size() > size + 4;
                            if (!close) peer.request.data.reserve(static_cast<size_t>(size) + 4);
                        }
                    }
                    SecureZeroMemory(chunk.data(), count);
                }
            }
            if (!close && FD_ISSET(peer.socket.value, &writes)) {
                const auto remaining = peer.response.data.size() - peer.sent;
                const int count = send(peer.socket.value, reinterpret_cast<const char*>(peer.response.data.data() + peer.sent),
                    static_cast<int>((std::min)(remaining, size_t(65536))), 0);
                if (count > 0) {
                    peer.sent += count;
                    if (peer.sent == peer.response.data.size()) { shutdown(peer.socket.value, SD_SEND); close = true; }
                } else close = count == 0 || WSAGetLastError() != WSAEWOULDBLOCK;
            }
            if (close) { const auto id = it->first; it = peers.erase(it); unixEvent(3, id); }
            else ++it;
        }
    }
    peers.clear(); closesocket(listener.value); listener.value = INVALID_SOCKET;
    const auto current = unixLeaf(leaf.value, socketPath);
    require(current.dwVolumeSerialNumber == identity.dwVolumeSerialNumber && current.nFileIndexHigh == identity.nFileIndexHigh
        && current.nFileIndexLow == identity.nFileIndexLow);
    FILE_DISPOSITION_INFO disposition{TRUE};
    require(SetFileInformationByHandle(leaf.value, FileDispositionInfo, &disposition, sizeof(disposition)) != 0);
    // Release the owned leaf before ACK, so channel rotation cannot race delete-pending.
    leaf = Handle(); unixEvent(4, 0);
}
