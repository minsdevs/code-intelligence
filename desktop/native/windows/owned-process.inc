// Included inside the boundary implementation's private namespace.
std::wstring quoteArgument(const std::wstring& value) {
    std::wstring result = L"\""; size_t slashes = 0;
    for (wchar_t c : value) {
        if (c == L'\\') { ++slashes; continue; }
        if (c == L'\"') result.append(slashes * 2 + 1, L'\\');
        else result.append(slashes, L'\\');
        slashes = 0; result += c;
    }
    result.append(slashes * 2, L'\\'); result += L'\"'; return result;
}
struct ProcessCleanup {
    HANDLE process;
    bool owned = false;
    ~ProcessCleanup() { if (!owned) { TerminateProcess(process, 1); WaitForSingleObject(process, 10000); } }
};
struct AttributeList {
    std::vector<unsigned char> bytes;
    LPPROC_THREAD_ATTRIBUTE_LIST list = nullptr;
    AttributeList() {
        SIZE_T size = 0; InitializeProcThreadAttributeList(nullptr, 1, 0, &size);
        require(size > 0); bytes.resize(size);
        list = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(bytes.data());
        require(InitializeProcThreadAttributeList(list, 1, 0, &size) != 0);
    }
    ~AttributeList() { if (list) DeleteProcThreadAttributeList(list); }
};
void managedProcess() {
    auto command = checkedPath(wide(field(16384)));
    auto cwd = checkedPath(wide(field(16384)));
    auto log = checkedPath(wide(field(16384)));
    auto commandChain = ancestors(command); auto executable = openObject(command, false);
    inspect(executable.value, false, false);
    auto cwdChain = ancestors(cwd); auto cwdHandle = openObject(cwd, true, READ_CONTROL | FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE);
    inspect(cwdHandle.value, true, false);
    auto logChain = ancestors(log); inspect(logChain.back().value, true, true);
    std::wstring commandLine = quoteArgument(command);
    auto count = number(); require(count <= 128);
    for (uint32_t i = 0; i < count; ++i) { commandLine += L" " + quoteArgument(wide(field(8192))); require(commandLine.size() < 32767); }
    auto envCount = number(); require(envCount > 0 && envCount <= 128);
    std::vector<std::wstring> environment;
    for (uint32_t i = 0; i < envCount; ++i) {
        auto name = wide(field(128)); auto value = wide(field(32768));
        require(!name.empty() && name.find_first_not_of(L"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_") == std::wstring::npos && !(name[0] >= L'0' && name[0] <= L'9'));
        environment.push_back(name + L"=" + value);
    }
    std::sort(environment.begin(), environment.end(), [](const auto& a, const auto& b) { return _wcsicmp(a.c_str(), b.c_str()) < 0; });
    std::wstring environmentBlock; std::wstring previous;
    for (const auto& value : environment) {
        auto name = value.substr(0,value.find(L'='));
        require(previous.empty() || _wcsicmp(previous.c_str(), name.c_str()) != 0); previous = name;
        environmentBlock += value; environmentBlock += L'\0'; require(environmentBlock.size() < 32767);
    }
    environmentBlock += L'\0';
    auto bootstrapLength = number(); require(bootstrapLength <= 16384);
    Secret bootstrap; bootstrap.data.resize(bootstrapLength); readExact(bootstrap.data.data(), bootstrapLength);
    PrivateSecurity sec;
    Handle logHandle(CreateFileW(filesystemPath(log).c_str(), GENERIC_WRITE | GENERIC_READ | READ_CONTROL, FILE_SHARE_READ, &sec.attributes, OPEN_ALWAYS, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    inspect(logHandle.value, false, true);
    LARGE_INTEGER end{}; require(SetFilePointerEx(logHandle.value, end, nullptr, FILE_END) != 0);
    Handle inputRead, inputWrite;
    SECURITY_ATTRIBUTES inheritable{ sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE };
    require(CreatePipe(&inputRead.value, &inputWrite.value, &inheritable, 32768) != 0);
    require(SetHandleInformation(inputWrite.value, HANDLE_FLAG_INHERIT, 0) != 0);
    require(SetHandleInformation(logHandle.value, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) != 0);
    AttributeList attributes;
    HANDLE inherited[] = { inputRead.value, logHandle.value };
    require(UpdateProcThreadAttribute(attributes.list, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherited, sizeof(inherited), nullptr, nullptr) != 0);
    // Job handle is unnamed, non-inheritable and held by this guardian only.
    Handle job(CreateJobObjectW(nullptr, nullptr)); require(job.value != nullptr);
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    require(SetInformationJobObject(job.value, JobObjectExtendedLimitInformation, &limits, sizeof(limits)) != 0);
    STARTUPINFOEXW startup{}; startup.StartupInfo.cb = sizeof(startup);
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = inputRead.value;
    startup.StartupInfo.hStdOutput = logHandle.value;
    startup.StartupInfo.hStdError = logHandle.value;
    startup.lpAttributeList = attributes.list;
    PROCESS_INFORMATION process{};
    require(CreateProcessW(command.c_str(), commandLine.data(), nullptr, nullptr, TRUE,
        CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT,
        environmentBlock.data(), cwd.c_str(), &startup.StartupInfo, &process) != 0);
    SecureZeroMemory(environmentBlock.data(), environmentBlock.size() * sizeof(wchar_t));
    for (auto& value : environment) SecureZeroMemory(value.data(), value.size() * sizeof(wchar_t));
    Handle child(process.hProcess), thread(process.hThread);
    ProcessCleanup unassigned{child.value};
    require(AssignProcessToJobObject(job.value, child.value) != 0);
    unassigned.owned = true;
    require(ResumeThread(thread.value) != static_cast<DWORD>(-1));
    inputRead = Handle();
    // Bootstrap fits in the dedicated pipe buffer; close after this one transfer.
    if (!bootstrap.data.empty()) { DWORD n = 0; require(WriteFile(inputWrite.value, bootstrap.data.data(), bootstrapLength, &n, nullptr) && n == bootstrapLength); }
    if (!bootstrap.data.empty()) SecureZeroMemory(bootstrap.data.data(), bootstrap.data.size());
    inputWrite = Handle();
    const auto pid = std::to_string(process.dwProcessId);
    json("{\"version\":1,\"kind\":\"STARTED\",\"pid\":\"" + pid + "\",\"startedAt\":null}");
    bool stopped = false;
    std::vector<unsigned char> control;
    while (WaitForSingleObject(child.value, 20) == WAIT_TIMEOUT) {
        DWORD available = 0;
        if (!PeekNamedPipe(GetStdHandle(STD_INPUT_HANDLE), nullptr, 0, nullptr, &available, nullptr)) { stopped = true; break; }
        if (!available) continue;
        require(control.size() + available <= 1028);
        std::array<unsigned char,1028> buffer{}; DWORD received = 0;
        require(ReadFile(GetStdHandle(STD_INPUT_HANDLE), buffer.data(), available, &received, nullptr) && received);
        control.insert(control.end(), buffer.begin(), buffer.begin() + received);
        if (control.size() < 4) continue;
        auto size = (uint32_t(control[0]) << 24) | (uint32_t(control[1]) << 16) | (uint32_t(control[2]) << 8) | control[3];
        require(size > 0 && size <= 1024 && control.size() <= size + 4);
        if (control.size() != size + 4) continue;
        const std::string text(control.begin() + 4, control.end());
        require(text == "{\"version\":1,\"kind\":\"STOP\",\"signal\":\"SIGTERM\"}" || text == "{\"version\":1,\"kind\":\"STOP\",\"signal\":\"SIGKILL\"}");
        stopped = true; break;
    }
    DWORD exitCode = 0;
    if (!stopped) require(GetExitCodeProcess(child.value, &exitCode) != 0 && exitCode != STILL_ACTIVE);
    require(TerminateJobObject(job.value, 1) != 0);
    require(WaitForSingleObject(child.value, 15000) == WAIT_OBJECT_0);
    if (stopped) require(GetExitCodeProcess(child.value, &exitCode) != 0);
    bool empty = false;
    for (int attempt = 0; attempt < 750; ++attempt) {
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info{};
        require(QueryInformationJobObject(job.value, JobObjectBasicAccountingInformation, &info, sizeof(info), nullptr) != 0);
        if (info.ActiveProcesses == 0) { empty = true; break; }
        Sleep(20);
    }
    require(empty);
    json("{\"version\":1,\"kind\":\"EXIT\",\"pid\":\"" + pid + "\",\"exitCode\":" + std::to_string(static_cast<int32_t>(exitCode)) + ",\"stopped\":true}");
}
