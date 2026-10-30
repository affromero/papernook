import type { NextRequest } from "next/server";
import {
  pdfGet,
  pdfHead,
  pdfPut,
  type PdfRouteParams,
} from "@/lib/library/pdf/http";
export const dynamic = "force-dynamic";
export function GET(request: NextRequest, context: PdfRouteParams) {
  return pdfGet(request, context, "exercises");
}
export function HEAD(request: NextRequest, context: PdfRouteParams) {
  return pdfHead(request, context, "exercises");
}
export function PUT(request: NextRequest, context: PdfRouteParams) {
  return pdfPut(request, context, "exercises");
}
