export interface TcCommand {
  command: string;
  args: string[];
}

export class TcBuilder {
  static replaceHtbRootQdisc(
    interfaceName: string,
  ): TcCommand {
    return {
      command: "tc",
      args: [
        "qdisc",
        "replace",
        "dev",
        interfaceName,
        "root",
        "handle",
        "1:",
        "htb",
        "default",
        "1",
      ],
    };
  }

  static addRootClass(
    interfaceName: string,
    rate: string,
  ): TcCommand {
    return {
      command: "tc",
      args: [
        "class",
        "add",
        "dev",
        interfaceName,
        "parent",
        "1:",
        "classid",
        "1:1",
        "htb",
        "rate",
        rate,
        "ceil",
        rate,
      ],
    };
  }

  static addClass(
    interfaceName: string,
    classId: string,
    rate: string,
  ): TcCommand {
    return {
      command: "tc",
      args: [
        "class",
        "add",
        "dev",
        interfaceName,
        "parent",
        "1:1",
        "classid",
        `1:${classId}`,
        "htb",
        "rate",
        rate,
        "ceil",
        rate,
      ],
    };
  }

  static changeClassRate(
    interfaceName: string,
    classId: string,
    rate: string,
  ): TcCommand {
    return {
      command: "tc",
      args: [
        "class",
        "change",
        "dev",
        interfaceName,
        "classid",
        `1:${classId}`,
        "htb",
        "rate",
        rate,
        "ceil",
        rate,
      ],
    };
  }

  static addDownloadFilterByIp(
    interfaceName: string,
    ip: string,
    classId: string,
    priority: number,
  ): TcCommand {
    return {
      command: "tc",
      args: [
        "filter",
        "add",
        "dev",
        interfaceName,
        "protocol",
        "ip",
        "parent",
        "1:",
        "prio",
        priority.toString(),
        "u32",
        "match",
        "ip",
        "dst",
        `${ip}/32`,
        "flowid",
        `1:${classId}`,
      ],
    };
  }

  static addUploadFilterByIp(
    interfaceName: string,
    ip: string,
    classId: string,
    priority: number,
  ): TcCommand {
    return {
      command: "tc",
      args: [
        "filter",
        "add",
        "dev",
        interfaceName,
        "protocol",
        "ip",
        "parent",
        "1:",
        "prio",
        priority.toString(),
        "u32",
        "match",
        "ip",
        "src",
        `${ip}/32`,
        "flowid",
        `1:${classId}`,
      ],
    };
  }

  static deleteFilter(
    interfaceName: string,
    priority: number,
  ): TcCommand {
    return {
      command: "tc",
      args: [
        "filter",
        "del",
        "dev",
        interfaceName,
        "parent",
        "1:",
        "pref",
        priority.toString(),
      ],
    };
  }

  static deleteClass(
    interfaceName: string,
    classId: string,
  ): TcCommand {
    return {
      command: "tc",
      args: [
        "class",
        "del",
        "dev",
        interfaceName,
        "classid",
        `1:${classId}`,
      ],
    };
  }

  static deleteRootQdisc(
    interfaceName: string,
  ): TcCommand {
    return {
      command: "tc",
      args: [
        "qdisc",
        "del",
        "dev",
        interfaceName,
        "root",
      ],
    };
  }
}
