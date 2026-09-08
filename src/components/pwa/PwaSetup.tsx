"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { probeConnection, refreshOffline } from "@/lib/offline/download";
import {
  clearOfflineForAuthentication,
  OfflineIdentityChangedError,
  getOfflineIdentity,
  offlineError,
  setOfflineIdentity,
  subscribeOffline,
} from "@/lib/offline/storage";
import styles from "@/components/offline/Offline.module.css";
import { reportServerConnection } from "@/components/offline/useConnection";

/** Reconcile device identity and use the saved reader when the server is down. */
export function PwaSetup() {
  const pathname = usePathname();
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if ("serviceWorker" in navigator && window.isSecureContext) {
      void navigator.serviceWorker
        .register("/sw.js", { updateViaCache: "none" })
        .catch((error) =>
          setNotice(
            `Offline reader could not be installed: ${offlineError(error)}`,
          ),
        );
    }
  }, []);
  useEffect(() => {
    let active = true;
    let checking = false;
    let refreshing = false;
    let owner: string | null = null;
    const publicPage =
      pathname === "/login" ||
      pathname.startsWith("/share/") ||
      pathname.startsWith("/add") ||
      pathname === "/invite";
    if (pathname === "/login") void clearOfflineForAuthentication();
    async function check() {
      if (checking || publicPage || !active) return;
      checking = true;
      try {
        const initialIdentity = await getOfflineIdentity().catch(() => null);
        const connection = await probeConnection();
        if (!active) return;
        reportServerConnection(
          connection.state === "online" || connection.state === "busy",
        );
        if (connection.state === "signed-out") {
          if (initialIdentity) {
            try {
              await setOfflineIdentity(null, initialIdentity);
            } catch (error) {
              if (error instanceof OfflineIdentityChangedError) return;
            }
          }
          await clearOfflineForAuthentication();
          location.replace("/login");
          return;
        }
        if (connection.state === "online") {
          if (!initialIdentity) {
            setNotice(
              "Offline storage is unavailable in this browser. Your online library is available.",
            );
            return;
          }
          const previous = initialIdentity;
          await setOfflineIdentity(connection.owner, initialIdentity);
          if (owner && owner !== connection.owner) {
            location.reload();
            return;
          }
          owner = connection.owner;
          if (previous.owner && previous.owner !== owner) {
            location.reload();
            return;
          }
          setNotice(null);
          if (!refreshing) {
            refreshing = true;
            void refreshOffline()
              .catch((error) => {
                if (active)
                  setNotice(
                    `Offline download update failed: ${offlineError(error)}`,
                  );
              })
              .finally(() => {
                refreshing = false;
              });
          }
          return;
        }
        if (connection.state === "busy") return;
        const draft = [...document.querySelectorAll("textarea")].some(
          (textarea) => textarea.value.trim(),
        );
        if (draft) {
          setNotice(
            "Server unavailable. Your draft is still here. Open your downloaded library to read offline.",
          );
          return;
        }
        if (navigator.serviceWorker?.controller)
          location.replace(
            `/offline/index.html?return=${encodeURIComponent(location.pathname + location.search)}`,
          );
        else
          setNotice(
            "Server unavailable. Connect once to install the offline reader.",
          );
      } catch (error) {
        if (active)
          setNotice(`Offline storage unavailable: ${offlineError(error)}`);
      } finally {
        checking = false;
      }
    }
    const unsubscribe = subscribeOffline(() => {
      void getOfflineIdentity()
        .then((identity) => {
          if (active && owner && identity.owner !== owner && !publicPage)
            location.replace("/login");
        })
        .catch(() => {});
    });
    void check();
    const timer = window.setInterval(() => {
      void check();
    }, 15_000);
    const onConnection = () => {
      void check();
    };
    window.addEventListener("online", onConnection);
    window.addEventListener("offline", onConnection);
    return () => {
      active = false;
      unsubscribe();
      clearInterval(timer);
      window.removeEventListener("online", onConnection);
      window.removeEventListener("offline", onConnection);
    };
  }, [pathname]);
  return notice ? (
    <div className={styles.banner} role="status">
      {notice} <a href="/offline/index.html">Downloads</a>
    </div>
  ) : null;
}
