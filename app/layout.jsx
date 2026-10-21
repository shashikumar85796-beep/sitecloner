import "./globals.css";

export const metadata = {
  title: "SiteCloner",
  description: "Paste a URL, preview the folder structure, download a ZIP.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
