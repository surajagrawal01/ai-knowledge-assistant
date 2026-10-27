import { readFileSync } from "node:fs";
import { prisma } from "../src/core/prisma.js";

const load = (name: string) =>
    JSON.parse(readFileSync(new URL(`./seed-data/${name}.json`, import.meta.url), "utf8"));

const daysAgo = (n: number | null) =>
    n === null ? null : new Date(Date.now() - n * 86_400_000);

async function seed() {
    // 1. Delete CHILDREN before PARENTS (foreign keys!)
    await prisma.ticket.deleteMany();
    await prisma.payment.deleteMany();
    await prisma.orderItem.deleteMany();
    await prisma.order.deleteMany();
    await prisma.product.deleteMany();
    await prisma.customer.deleteMany();

    // 2. Insert PARENTS before CHILDREN
    await prisma.customer.createMany({
        data: load("customers").map(({ joinedDaysAgo, ...c }: any) => ({ ...c, createdAt: daysAgo(joinedDaysAgo) })),
    });
    await prisma.product.createMany({ data: load("products") });
    await prisma.order.createMany({
        data: load("orders").map(({ orderedDaysAgo, shippedDaysAgo, deliveredDaysAgo, ...o }: any) => ({
            ...o,
            orderedAt: daysAgo(orderedDaysAgo),
            shippedAt: daysAgo(shippedDaysAgo),
            deliveredAt: daysAgo(deliveredDaysAgo),
        })),
    });
    await prisma.payment.createMany({
        data: load("payments").map(({ paidDaysAgo, ...o }: any) => ({
            ...o,
            paidAt: daysAgo(paidDaysAgo),
        })),
    });
    await prisma.orderItem.createMany({ data: load("order_items") });
    await prisma.ticket.createMany({
        data: load("tickets").map(({ createdDaysAgo, ...o }: any) =>
            ({ ...o, createdAt: daysAgo(createdDaysAgo) }))
    });
    // 3. order_items, payments (paidDaysAgo → paidAt), tickets (createdDaysAgo → createdAt)
    //    ...same pattern

    console.log("Seeded ✔");
}

seed().finally(() => prisma.$disconnect());