import { useState } from 'react';
import { Table, Card, Button, Modal, Input, Popconfirm, Message, Tag, Alert } from '@arco-design/web-react';
import {
  useCredentials, useIssueCredential, useRevokeCredential,
  type ProductCredentialInfo, type IssuedCredential,
} from '../api/queries.js';
import { PageHeader, ErrorBanner, Spinner, EmptyState } from '../components/Page.js';
import { relativeTime } from '../components/StatusPill.js';

// ============================================================
// Credentials — issue/revoke product-scoped bp_… tokens
// ============================================================
// a8s is multi-tenant: a product authenticates with a bp_… bearer token that
// scopes it to its own agents. The operator issues/rotates/revokes here. The
// token VALUE is shown exactly once (at issue time) — there's no way to recover
// it later, so the issue modal makes the operator copy it before closing.

export function CredentialsPage() {
  const creds = useCredentials();
  const issue = useIssueCredential();
  const revoke = useRevokeCredential();
  const [showIssue, setShowIssue] = useState(false);
  const [issued, setIssued] = useState<IssuedCredential | null>(null);

  if (creds.error) return <ErrorBanner error={creds.error} />;
  if (!creds.data) return <Spinner />;

  const columns = [
    { title: '产品', dataIndex: 'product', render: (v: string) => <code className="font-mono text-xs">{v}</code> },
    {
      title: '标签',
      dataIndex: 'label',
      render: (v: string | undefined) => v
        ? <span style={{ color: 'var(--color-text-2)' }}>{v}</span>
        : <span style={{ color: 'var(--color-text-4)' }}>—</span>,
    },
    {
      title: '创建',
      dataIndex: 'createdAt',
      render: (v: number) => <span className="text-xs" style={{ color: 'var(--color-text-3)' }}>{relativeTime(v)}</span>,
    },
    {
      title: '',
      dataIndex: '__actions',
      align: 'right' as const,
      width: 160,
      render: (_: unknown, c: ProductCredentialInfo) => (
        <div className="flex justify-end gap-1">
          <Button
            size="mini"
            type="text"
            loading={issue.isPending}
            onClick={async () => {
              const res = await issue.mutateAsync({ product: c.product, label: c.label });
              setIssued(res);
            }}
          >
            轮换
          </Button>
          <Popconfirm
            title={`吊销产品「${c.product}」的凭证?`}
            content="该产品的 token 将立即失效,需要重新发放。"
            okText="吊销"
            cancelText="取消"
            onOk={() => { revoke.mutate(c.product); Message.success(`已吊销 ${c.product}`); }}
          >
            <Button size="mini" type="text" status="danger">吊销</Button>
          </Popconfirm>
        </div>
      ),
    },
  ];

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Credentials"
        subtitle="产品级 scoped token — 每个产品只能看到自己的 agent"
        actions={<Button type="primary" onClick={() => setShowIssue(true)}>发放凭证</Button>}
      />

      <p className="text-sm -mt-3 mb-4 max-w-3xl" style={{ color: 'var(--color-text-3)' }}>
        产品用一个 <code className="font-mono text-xs mx-1">bp_…</code> token 直连 a8s,作用域被限制在它自己的资源。
        token 值只在<strong>发放那一刻</strong>显示一次,无法事后找回——请当场复制。
        「产品视图」= 用某个 product token 登录后看到的受限视图。
      </p>

      {creds.data.length === 0 ? (
        <EmptyState icon="🔑" title="还没有发放凭证" hint="点「发放凭证」给一个产品签发 scoped token。" />
      ) : (
        <Card bordered bodyStyle={{ padding: 0 }}>
          <Table rowKey="product" columns={columns} data={creds.data} pagination={false} size="small" />
        </Card>
      )}

      {showIssue && (
        <IssueModal
          pending={issue.isPending}
          error={issue.error}
          onClose={() => setShowIssue(false)}
          onIssue={async (product, label) => {
            const res = await issue.mutateAsync({ product, label: label || undefined });
            setShowIssue(false);
            setIssued(res);
          }}
        />
      )}

      {issued && <TokenRevealModal cred={issued} onClose={() => setIssued(null)} />}
    </div>
  );
}

function IssueModal({ pending, error, onClose, onIssue }: {
  pending: boolean;
  error: unknown;
  onClose: () => void;
  onIssue: (product: string, label: string) => void | Promise<void>;
}) {
  const [product, setProduct] = useState('');
  const [label, setLabel] = useState('');
  const valid = /^[a-z0-9][a-z0-9-]*$/.test(product);
  return (
    <Modal
      visible
      title="发放产品凭证"
      onCancel={onClose}
      footer={
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>取消</Button>
          <Button type="primary" loading={pending} disabled={!valid} onClick={() => void onIssue(product, label)}>发放</Button>
        </div>
      }
    >
      <label className="block mb-3">
        <span className="text-xs" style={{ color: 'var(--color-text-3)' }}>产品 ID(kebab-case)</span>
        <Input className="mt-1 font-mono" value={product} onChange={setProduct} placeholder="e.g. claw" autoFocus />
        {product.length > 0 && !valid && (
          <div className="text-xs mt-1" style={{ color: 'rgb(var(--red-6))' }}>只能用小写字母、数字、横线,且以字母/数字开头。</div>
        )}
      </label>
      <label className="block">
        <span className="text-xs" style={{ color: 'var(--color-text-3)' }}>标签(可选)</span>
        <Input className="mt-1" value={label} onChange={setLabel} placeholder="给这个凭证一句话备注" />
      </label>
      <p className="text-xs mt-3" style={{ color: 'var(--color-text-3)' }}>
        若该产品已有凭证,发放会<strong>轮换</strong>它(旧 token 立即失效)。
      </p>
      {error ? <div className="text-sm mt-2" style={{ color: 'rgb(var(--red-6))' }}>{error instanceof Error ? error.message : String(error)}</div> : null}
    </Modal>
  );
}

function TokenRevealModal({ cred, onClose }: { cred: IssuedCredential; onClose: () => void }) {
  return (
    <Modal
      visible
      title={<span>已发放「{cred.product}」的凭证</span>}
      onCancel={onClose}
      maskClosable={false}
      footer={
        <div className="flex justify-end gap-2">
          <Button type="primary" onClick={async () => { await navigator.clipboard.writeText(cred.token); Message.success('已复制 token'); }}>
            复制 token
          </Button>
          <Button onClick={onClose}>我已保存</Button>
        </div>
      }
    >
      <Alert
        type="warning"
        className="mb-3"
        content="这是你唯一一次看到完整 token。关闭后无法再找回——请现在复制保存。"
      />
      <div className="flex items-center gap-2 mb-2">
        <span className="text-xs" style={{ color: 'var(--color-text-3)' }}>产品</span>
        <Tag color="arcoblue">{cred.product}</Tag>
      </div>
      <pre
        className="overflow-auto p-3 rounded-md text-xs font-mono whitespace-pre-wrap break-all"
        style={{ background: 'var(--color-fill-2)', color: 'var(--color-text-1)' }}
      >
        {cred.token}
      </pre>
    </Modal>
  );
}
