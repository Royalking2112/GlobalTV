import { integer, jsonb, pgTable, text, timestamp, index } from "drizzle-orm/pg-core";

export type StreamSource = {
  url: string;
  quality: number; // vertical resolution, 0 = unknown
  referrer?: string | null;
  userAgent?: string | null;
};

export const channels = pgTable(
  "channels",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    country: text("country").notNull(),
    categories: jsonb("categories").$type<string[]>().notNull().default([]),
    network: text("network"),
    logo: text("logo"),
    website: text("website"),
    quality: integer("quality").notNull().default(0),
    streams: jsonb("streams").$type<StreamSource[]>().notNull().default([]),
  },
  (t) => [index("channels_country_idx").on(t.country), index("channels_name_idx").on(t.name)],
);

export const countries = pgTable("countries", {
  code: text("code").primaryKey(),
  name: text("name").notNull(),
  flag: text("flag").notNull().default(""),
  languages: jsonb("languages").$type<string[]>().notNull().default([]),
});

export const categories = pgTable("categories", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
});

export const syncMeta = pgTable("sync_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
