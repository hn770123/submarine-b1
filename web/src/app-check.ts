/** 本番で Firebase App Check token を発行し、同一オリジン API に添付する。 */
import { initializeApp } from "firebase/app";
import {
  getToken,
  initializeAppCheck,
  ReCaptchaEnterpriseProvider,
} from "firebase/app-check";

const projectId = import.meta.env.VITE_FIREBASE_PROJECT_ID;
const appId = import.meta.env.VITE_FIREBASE_APP_ID;
const apiKey = import.meta.env.VITE_FIREBASE_API_KEY;
const siteKey = import.meta.env.VITE_RECAPTCHA_ENTERPRISE_SITE_KEY;

// Emulator では設定を空にして外部サービスへの接続を避ける。
const appCheck =
  projectId && appId && apiKey && siteKey
    ? initializeAppCheck(
        initializeApp({ projectId, appId, apiKey }),
        {
          provider: new ReCaptchaEnterpriseProvider(siteKey),
          isTokenAutoRefreshEnabled: true,
        },
      )
    : null;

/** token を URL や保存領域へ入れず、各リクエスト直前に取得する。 */
export async function appCheckHeader(): Promise<Record<string, string>> {
  if (!appCheck) return {};
  return { "X-Firebase-AppCheck": (await getToken(appCheck)).token };
}
