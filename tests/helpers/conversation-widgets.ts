// Synthetic values, with field contracts checked against the captured producer renderer:
// https://github.com/Marc0Guo/IntelligenceUI/blob/ded0d5e033f2be02ef01de64abeaff417e36a994/ui-modules/assistant-canonical-dil-v2-D3Mxms_M.js
export const weatherState = {
  initial_unit: "c",
  forecast: {
    location_label: "Example City",
    current: {
      description: "Clear",
      temperature: { label_c: "12°C", label_f: "53.6°F" },
    },
    daily: [
      {
        date_key: "2026-10-12",
        label: "Monday",
        description: "Clear skies",
        low: { label_c: "7°C", label_f: "44.6°F" },
        high: { label_c: "18°C", label_f: "64.4°F" },
      },
      {
        date_key: "2026-10-13",
        label: "Tuesday",
        description: "Light rain",
        low: { label_c: "8°C", label_f: "46.4°F" },
        high: { label_c: "15°C", label_f: "59°F" },
      },
    ],
    hourly_chart: [
      { timestamp: "09:00", temp_c: 12, temp_f: 53.6, precip_chance: 0 },
      { timestamp: "10:00", temp_c: null, temp_f: null, precip_chance: null },
      { timestamp: "11:00", temp_c: 14, temp_f: 57.2, precip_chance: 10 },
    ],
  },
};
export const quoteState = {
  asset_display_name: "Example Corp (EXM)",
  current_price_text: "$104.25 USD",
  default_range: "1D",
  timeframe_order: ["1D"],
  timeframe_configs: {
    "1D": {
      summary: {
        price_change_text: "+$1.25 (+1.21%)",
        trade_date_text: "Oct 12, 2026, 16:00 EDT",
      },
      chart: {
        xAxis: { dataKey: "time" },
        series: [
          { dataKey: "close", label: "EXM", type: "line", valuePrefix: "$" },
        ],
        data: [
          { time: "09:30", close: 103 },
          { time: "12:00", close: 104.7 },
          { time: "16:00", close: 104.25 },
        ],
      },
    },
  },
  metrics_display: [
    {
      cols: [
        { label: "Open", value: "$103.00" },
        { label: "Volume", value: "0" },
      ],
    },
  ],
  after_hours: {
    label: "After hours",
    price_text: "$104.30",
    change_text: "+$0.05",
    percent_text: "+0.05%",
  },
};
export const scheduleState = {
  title: "Saved basketball schedule",
  rows: [
    {
      label: "October 12",
      games: [
        {
          game: {
            primaryLabel: "Final",
            secondaryLabel: "Example Arena",
            teams: [
              { name: "Home", hasScore: true, score: 0 },
              { name: "Away", hasScore: false, score: 0 },
            ],
          },
        },
      ],
    },
  ],
};
export const mapState = {
  title: "Saved places",
  places: [
    {
      name: "Library",
      latitude: 51.5074,
      longitude: -0.1278,
      category: "Library",
      rating: 4.5,
      price: "Free",
    },
    {
      name: "Museum",
      latitude: 51.5194,
      longitude: -0.127,
      category: "Museum",
    },
  ],
};
export const widgetParts = [
  { type: "widget", component: "WeatherWidget.V3", state: weatherState },
  { type: "widget", component: "StockQuoteWidget", state: quoteState },
  { type: "widget", component: "NbaGamesSchedule", state: scheduleState },
  { type: "widget", component: "MapWidget", state: mapState },
];
