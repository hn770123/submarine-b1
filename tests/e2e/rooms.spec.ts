/** 二つの独立ブラウザで参加・再読み込み復帰と三人目の拒否を確認する。 */
import { test, expect } from "@playwright/test";
test("作成・参加・復帰・満員・360px 表示", async ({ browser }) => {
  const hostContext = await browser.newContext({
      viewport: { width: 360, height: 800 },
      reducedMotion: "reduce",
    }),
    guestContext = await browser.newContext({
      viewport: { width: 360, height: 800 },
    });
  const host = await hostContext.newPage(),
    guest = await guestContext.newPage();
  await host.goto("/");
  await host.getByLabel("表示名", { exact: true }).fill("ホスト");
  await host.getByLabel("表示名", { exact: true }).press("Tab");
  await expect(host.getByLabel("パスコード", { exact: true })).toBeFocused();
  await host.getByLabel("パスコード", { exact: true }).fill("secret12");
  await host.getByLabel("パスコード", { exact: true }).press("Enter");
  const code = await host.locator(".code").innerText();
  await expect(
    host.getByRole("heading", { name: "相手の参加を待っています" }),
  ).toBeVisible();
  await host.screenshot({
    path: "test-results/room-waiting-360.png",
    fullPage: true,
  });
  await guest.goto("/");
  await guest
    .getByRole("button", { name: "ルームに参加", exact: true })
    .click();
  await guest.getByLabel("表示名", { exact: true }).fill("ゲスト");
  await guest.getByLabel("ルームコード", { exact: true }).fill(code);
  await guest.getByLabel("パスコード", { exact: true }).fill("secret12");
  await guest.getByRole("button", { name: "参加する", exact: true }).click();
  await expect(
    guest.getByRole("heading", { name: "2人の参加が完了しました" }),
  ).toBeVisible();
  await expect(
    host.getByRole("heading", { name: "2人の参加が完了しました" }),
  ).toBeVisible();
  await guest.reload();
  await expect(guest.locator(".players")).toContainText("ゲスト（あなた）");
  await host.reload();
  await expect(host.locator(".players")).toContainText("ホスト（あなた）");
  const thirdContext = await browser.newContext();
  const third = await thirdContext.newPage();
  await third.goto("/");
  await third
    .getByRole("button", { name: "ルームに参加", exact: true })
    .click();
  await third.getByLabel("表示名", { exact: true }).fill("三人目");
  await third.getByLabel("ルームコード", { exact: true }).fill(code);
  await third.getByLabel("パスコード", { exact: true }).fill("secret12");
  await third.getByRole("button", { name: "参加する", exact: true }).click();
  await expect(third.getByRole("alert")).toHaveText("このルームは満員です。");
  expect(
    await host.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await host.screenshot({
    path: "test-results/room-ready-360.png",
    fullPage: true,
  });
  await host.setViewportSize({ width: 1280, height: 900 });
  await host.screenshot({
    path: "test-results/room-ready-desktop.png",
    fullPage: true,
  });
  await hostContext.close();
  await guestContext.close();
  await thirdContext.close();
});
