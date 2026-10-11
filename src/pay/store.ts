import fs from "node:fs";
import path from "node:path";
import type { ArchiveRecord, Entitlement, Order } from "./types.ts";

interface Persisted {
  orders: Order[];
  entitlements: Entitlement[];
  archives: ArchiveRecord[];
}

export class MemoryStore {
  orders = new Map<string, Order>();
  entitlements = new Map<string, Entitlement>();
  archives: ArchiveRecord[] = [];

  saveOrder(order: Order): void {
    this.orders.set(order.orderId, order);
  }

  getOrder(orderId: string): Order | undefined {
    return this.orders.get(orderId);
  }

  getOrderByOutTradeNo(outTradeNo: string): Order | undefined {
    for (const order of this.orders.values()) {
      if (order.outTradeNo === outTradeNo) return order;
    }
    return undefined;
  }

  saveEntitlement(entitlement: Entitlement): void {
    this.entitlements.set(entitlement.buyerId, entitlement);
  }

  getEntitlement(buyerId: string): Entitlement | undefined {
    return this.entitlements.get(buyerId);
  }

  saveArchive(record: ArchiveRecord): void {
    const index = this.archives.findIndex((item) => item.callId === record.callId);
    if (index >= 0) this.archives[index] = record;
    else this.archives.push(record);
  }

  archivesFor(buyerId: string, orderId: string): ArchiveRecord[] {
    return this.archives.filter((item) => item.buyerId === buyerId && item.orderId === orderId);
  }

  snapshot(): Persisted {
    return {
      orders: [...this.orders.values()],
      entitlements: [...this.entitlements.values()],
      archives: this.archives,
    };
  }

  load(data: Persisted): void {
    this.orders = new Map(data.orders.map((order) => [order.orderId, order]));
    this.entitlements = new Map(data.entitlements.map((item) => [item.buyerId, item]));
    this.archives = data.archives;
  }
}

export class FileStore extends MemoryStore {
  private readonly filePath: string;

  constructor(filePath: string) {
    super();
    this.filePath = filePath;
    if (!fs.existsSync(filePath)) return;
    const raw = fs.readFileSync(filePath, "utf8");
    if (!raw.trim()) return;
    this.load(JSON.parse(raw) as Persisted);
  }

  override saveOrder(order: Order): void {
    super.saveOrder(order);
    this.flush();
  }

  override saveEntitlement(entitlement: Entitlement): void {
    super.saveEntitlement(entitlement);
    this.flush();
  }

  override saveArchive(record: ArchiveRecord): void {
    super.saveArchive(record);
    this.flush();
  }

  private flush(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.snapshot(), null, 2));
  }
}
