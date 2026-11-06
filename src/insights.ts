import {
  Controller,
  Get,
  Header,
  Injectable,
  Query,
  UseGuards,
} from "@nestjs/common";
import { PrismaService } from "./prisma.service";
import { AuthGuard, CurrentUser, Roles } from "./common";

const DAY = 86400000;
const lagos = (d: Date) => new Date(d.getTime() + 3600000); // Lagos is UTC+1 all year
const dayKey = (d: Date) => lagos(d).toISOString().slice(0, 10);
const hourOf = (d: Date) => lagos(d).getUTCHours();
const pct = (a: number, b: number) =>
  b > 0 ? Math.round((a / b) * 100) : null;
const COUNTED = ["RESERVED", "PICKED_UP", "EXPIRED"]; // paid and not cancelled
const band = (price: number, original: number) => {
  const d = 1 - price / original;
  return d < 0.4 ? "Under 40% off" : d < 0.5 ? "40-49% off" : "50% off or more";
};

/**
 * A seller's own numbers, worked out from the orders and listings we already store. Nothing new is saved.
 * "Sold" means paid and not cancelled. "Unsold" means units left on listings that have finished.
 * (This is surplus that stayed unsold on GbaanJo. Full waste tracking needs inventory, which comes later.)
 */
@Injectable()
export class InsightsService {
  constructor(private prisma: PrismaService) {}

  async summary(sellerId: string, days: number) {
    const now = new Date();
    const since = new Date(now.getTime() - days * DAY);
    const [orders, ended] = await Promise.all([
      this.prisma.order.findMany({
        where: { listing: { sellerId }, paidAt: { gte: since } },
        select: {
          quantity: true,
          totalPrice: true,
          sellerAmount: true,
          status: true,
          refundDue: true,
          refundedAt: true,
          paidAt: true,
          listing: { select: { title: true, category: true } },
        },
        take: 5000,
      }),
      this.prisma.listing.findMany({
        where: {
          sellerId,
          saleEndsAt: { gte: since, lte: now },
          status: { not: "CANCELLED" },
        },
        select: {
          category: true,
          quantity: true,
          quantityLeft: true,
          originalPrice: true,
          price: true,
        },
        take: 5000,
      }),
    ]);

    const counted = orders.filter(
      (o) => COUNTED.includes(o.status) && !o.refundDue && !o.refundedAt,
    );
    const handedOver = counted.filter((o) => o.status === "PICKED_UP").length;
    const noShows = counted.filter((o) => o.status === "EXPIRED").length;
    const refunded = orders.filter((o) => o.refundDue || o.refundedAt).length;
    const recovered = counted.reduce((s, o) => s + o.sellerAmount, 0);
    const gross = counted.reduce((s, o) => s + o.totalPrice, 0);
    const units = counted.reduce((s, o) => s + o.quantity, 0);

    // Money per day, with empty days filled in so the chart has no gaps
    const perDay = new Map<string, { revenue: number; units: number }>();
    for (const o of counted) {
      const k = dayKey(o.paidAt);
      const e = perDay.get(k) || { revenue: 0, units: 0 };
      e.revenue += o.sellerAmount;
      e.units += o.quantity;
      perDay.set(k, e);
    }
    const byDay: { date: string; revenue: number; units: number }[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const k = dayKey(new Date(now.getTime() - i * DAY));
      byDay.push({
        date: k,
        revenue: perDay.get(k)?.revenue || 0,
        units: perDay.get(k)?.units || 0,
      });
    }

    // When customers pay (Lagos hour of day)
    const hours = Array(24).fill(0);
    for (const o of counted) hours[hourOf(o.paidAt)] += 1;
    const bestHours = hours
      .map((count, hour) => ({ hour, count }))
      .filter((h) => h.count > 0)
      .sort((a, b) => b.count - a.count)
      .slice(0, 3);

    // What sells
    const items = new Map<
      string,
      { title: string; units: number; revenue: number }
    >();
    for (const o of counted) {
      const e = items.get(o.listing.title) || {
        title: o.listing.title,
        units: 0,
        revenue: 0,
      };
      e.units += o.quantity;
      e.revenue += o.sellerAmount;
      items.set(o.listing.title, e);
    }
    const topItems = [...items.values()]
      .sort((a, b) => b.units - a.units)
      .slice(0, 5);

    // Finished listings: how much of what you offered sold, by category and by discount depth
    const group = (key: (l: any) => string) => {
      const m = new Map<
        string,
        { name: string; listings: number; offered: number; left: number }
      >();
      for (const l of ended) {
        const k = key(l);
        const e = m.get(k) || { name: k, listings: 0, offered: 0, left: 0 };
        e.listings++;
        e.offered += l.quantity;
        e.left += l.quantityLeft;
        m.set(k, e);
      }
      return [...m.values()].map((e) => ({
        ...e,
        sellThrough: pct(e.offered - e.left, e.offered),
      }));
    };
    const revenueByCategory = new Map<string, number>();
    for (const o of counted)
      revenueByCategory.set(
        o.listing.category,
        (revenueByCategory.get(o.listing.category) || 0) + o.sellerAmount,
      );
    const byCategory = group((l) => l.category)
      .map((c) => ({ ...c, revenue: revenueByCategory.get(c.name) || 0 }))
      .sort((a, b) => b.revenue - a.revenue);
    const byDiscount = group((l) => band(l.price, l.originalPrice));

    const offered = ended.reduce((s, l) => s + l.quantity, 0);
    const left = ended.reduce((s, l) => s + l.quantityLeft, 0);
    return {
      days,
      sample: { orders: counted.length, listings: ended.length },
      revenue: { recovered, gross, units },
      pickup: {
        handedOver,
        noShows,
        noShowRate: pct(noShows, handedOver + noShows),
        refunded,
      },
      listings: {
        ended: ended.length,
        offered,
        unsold: left,
        sellThrough: pct(offered - left, offered),
        unsoldRetailValue: ended.reduce(
          (s, l) => s + l.quantityLeft * l.originalPrice,
          0,
        ),
        avgDiscountPct: ended.length
          ? Math.round(
              (ended.reduce((s, l) => s + (1 - l.price / l.originalPrice), 0) /
                ended.length) *
                100,
            )
          : null,
      },
      byDay,
      byCategory,
      byDiscount,
      topItems,
      bestHours,
    };
  }

  // A spreadsheet of the seller's paid orders. Cells that start with = + - or @ are defused so Excel cannot run them as formulas.
  async salesCsv(sellerId: string, days: number) {
    const since = new Date(Date.now() - days * DAY);
    const rows = await this.prisma.order.findMany({
      where: { listing: { sellerId }, paidAt: { gte: since } },
      orderBy: { paidAt: "desc" },
      take: 5000,
      select: {
        orderNo: true,
        quantity: true,
        totalPrice: true,
        amountPaid: true,
        sellerAmount: true,
        status: true,
        refundDue: true,
        refundedAt: true,
        paidOutAt: true,
        paidAt: true,
        listing: { select: { title: true } },
      },
    });
    const cell = (v: any) => {
      let s = String(v ?? "");
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
      return '"' + s.replace(/"/g, '""') + '"';
    };
    const head = [
      "Paid on (Lagos time)",
      "Order",
      "Item",
      "Units",
      "Food total (NGN)",
      "Customer paid (NGN)",
      "Your earnings (NGN)",
      "Status",
      "Paid out to you on",
    ];
    const lines = rows.map((o) =>
      [
        lagos(o.paidAt).toISOString().replace("T", " ").slice(0, 16),
        o.orderNo,
        o.listing.title,
        o.quantity,
        o.totalPrice,
        o.amountPaid,
        o.sellerAmount,
        o.refundedAt ? "REFUNDED" : o.refundDue ? "REFUND DUE" : o.status,
        o.paidOutAt ? lagos(o.paidOutAt).toISOString().slice(0, 10) : "",
      ]
        .map(cell)
        .join(","),
    );
    return (
      "\uFEFF" + [head.map(cell).join(","), ...lines].join("\r\n") + "\r\n"
    );
  }
}

@Controller("insights")
@UseGuards(AuthGuard)
@Roles("SELLER")
export class InsightsController {
  constructor(private svc: InsightsService) {}
  private days(v: string | undefined, fallback: number) {
    const n = parseInt(v || "", 10);
    return Number.isFinite(n) ? Math.min(Math.max(n, 1), 365) : fallback;
  }

  @Get("summary") summary(@CurrentUser() u: any, @Query("days") days?: string) {
    return this.svc.summary(u.sub, this.days(days, 30));
  }

  @Header("Content-Type", "text/csv; charset=utf-8")
  @Header("Content-Disposition", 'attachment; filename="gbaanjo-sales.csv"')
  @Get("sales.csv")
  csv(@CurrentUser() u: any, @Query("days") days?: string) {
    return this.svc.salesCsv(u.sub, this.days(days, 90));
  }
}
