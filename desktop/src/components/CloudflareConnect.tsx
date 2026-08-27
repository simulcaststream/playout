type Props = {
  accountId: string | null;
  hasR2S3Keys?: boolean;
  compact?: boolean;
};

export default function CloudflareConnect({ accountId, hasR2S3Keys }: Props) {
  return (
    <div className="cf-connect">
      <div className="cf-status">
        {hasR2S3Keys ? (
          <p className="success">Cloudflare connected{accountId ? ` · ${accountId}` : ""}</p>
        ) : (
          <p className="error">Cloudflare keys missing. Uploads are disabled.</p>
        )}
      </div>
    </div>
  );
}
