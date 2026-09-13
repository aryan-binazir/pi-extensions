import Foundation
import Security
import Darwin

let protocolLimit = 128 * 1024
let stateLimit = 64 * 1024

func runLockMode(_ path: String) -> Never {
    guard path.hasPrefix("/") else { exit(73) }
    let descriptor = open(path, O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC, S_IRUSR | S_IWUSR)
    guard descriptor >= 0 else { exit(73) }
    defer { close(descriptor) }

    var information = stat()
    guard fstat(descriptor, &information) == 0,
          information.st_uid == getuid(),
          information.st_mode & S_IFMT == S_IFREG,
          information.st_mode & 0o777 == 0o600 else { exit(73) }

    let deadline = DispatchTime.now().uptimeNanoseconds + 120_000_000_000
    while flock(descriptor, LOCK_EX | LOCK_NB) != 0 {
        guard errno == EWOULDBLOCK || errno == EAGAIN else { exit(73) }
        let now = DispatchTime.now().uptimeNanoseconds
        guard now < deadline else { exit(75) }
        let remainingMilliseconds = Int32(min((deadline - now) / 1_000_000, 250))
        var input = pollfd(fd: STDIN_FILENO, events: Int16(POLLIN | POLLHUP), revents: 0)
        let result = poll(&input, 1, remainingMilliseconds)
        if result < 0 {
            if errno == EINTR { continue }
            exit(73)
        }
        if result > 0 {
            if input.revents & Int16(POLLHUP | POLLERR | POLLNVAL) != 0 { exit(76) }
            if input.revents & Int16(POLLIN) != 0 {
                var byte: UInt8 = 0
                let count = read(STDIN_FILENO, &byte, 1)
                if count == 0 { exit(76) }
                if count < 0 && errno != EINTR && errno != EAGAIN { exit(73) }
            }
        }
    }

    let ready = Array("locked\n".utf8)
    guard ready.withUnsafeBytes({ write(STDOUT_FILENO, $0.baseAddress, $0.count) }) == ready.count else { exit(73) }
    var buffer = [UInt8](repeating: 0, count: 64)
    while true {
        let count = read(STDIN_FILENO, &buffer, buffer.count)
        if count == 0 { break }
        if count < 0 && errno != EINTR { exit(73) }
    }
    _ = flock(descriptor, LOCK_UN)
    exit(0)
}

if CommandLine.arguments.count > 1 {
    guard CommandLine.arguments.count == 3, CommandLine.arguments[1] == "--lock" else { exit(73) }
    runLockMode(CommandLine.arguments[2])
}

func respond(_ value: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: value) else {
        FileHandle.standardOutput.write(Data("{\"version\":1,\"ok\":false,\"error\":\"unavailable\"}".utf8))
        return
    }
    FileHandle.standardOutput.write(data)
}

func readRequest() -> Data? {
    var data = Data()
    while data.count <= protocolLimit {
        do {
            guard let chunk = try FileHandle.standardInput.read(upToCount: min(8192, protocolLimit + 1 - data.count)),
                  !chunk.isEmpty else { return data }
            data.append(chunk)
        } catch { return nil }
    }
    return nil
}

func errorName(_ status: OSStatus) -> String {
    switch status {
    case errSecAuthFailed, errSecInteractionNotAllowed, errSecUserCanceled:
        return "denied"
    case errSecNotAvailable:
        return "unavailable"
    default:
        return "unavailable"
    }
}

guard let input = readRequest(),
      let object = try? JSONSerialization.jsonObject(with: input),
      let request = object as? [String: Any],
      request["version"] as? Int == 1,
      request["service"] as? String == "Harbor MCP OAuth",
      let account = request["account"] as? String,
      account.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
      let action = request["action"] as? String,
      ["load", "save", "delete"].contains(action),
      Set(request.keys) == Set(action == "save"
        ? ["version", "action", "service", "account", "payload"]
        : ["version", "action", "service", "account"]) else {
    respond(["version": 1, "ok": false, "error": "invalid"])
    exit(0)
}

let query: [CFString: Any] = [
    kSecClass: kSecClassGenericPassword,
    kSecAttrService: "Harbor MCP OAuth",
    kSecAttrAccount: account,
]

if action == "load" {
    var item: CFTypeRef?
    var lookup = query
    lookup[kSecMatchLimit] = kSecMatchLimitOne
    lookup[kSecReturnData] = true
    let status = SecItemCopyMatching(lookup as CFDictionary, &item)
    if status == errSecItemNotFound {
        respond(["version": 1, "ok": true, "found": false])
    } else if status != errSecSuccess {
        respond(["version": 1, "ok": false, "error": errorName(status)])
    } else if let data = item as? Data, data.count <= stateLimit,
              let payload = try? JSONSerialization.jsonObject(with: data),
              payload is [String: Any] {
        respond(["version": 1, "ok": true, "found": true, "payload": payload])
    } else {
        respond(["version": 1, "ok": false, "error": "invalid"])
    }
} else if action == "save" {
    guard let payload = request["payload"] as? [String: Any],
          let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]),
          data.count <= stateLimit else {
        respond(["version": 1, "ok": false, "error": "invalid"])
        exit(0)
    }
    var status = SecItemUpdate(query as CFDictionary, [kSecValueData: data] as CFDictionary)
    if status == errSecItemNotFound {
        var addition = query
        addition[kSecValueData] = data
        addition[kSecAttrAccessible] = kSecAttrAccessibleWhenUnlocked
        status = SecItemAdd(addition as CFDictionary, nil)
        if status == errSecDuplicateItem {
            status = SecItemUpdate(query as CFDictionary, [kSecValueData: data] as CFDictionary)
        }
    }
    respond(status == errSecSuccess
        ? ["version": 1, "ok": true]
        : ["version": 1, "ok": false, "error": errorName(status)])
} else {
    let status = SecItemDelete(query as CFDictionary)
    respond(status == errSecSuccess || status == errSecItemNotFound
        ? ["version": 1, "ok": true]
        : ["version": 1, "ok": false, "error": errorName(status)])
}
