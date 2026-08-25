import { useState, useEffect, useCallback } from 'react';
import { fetchContactTypes, createContactType, renameContactType, deleteContactType, fetchContactTypeCounts, syncContactTypes } from '../services/contactsService';

// Standardized icon components (match the Contacts page visual language).
const iconProps = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

const PlusIcon = ({ size = 16 }: { size?: number }) => (
  <svg {...iconProps} width={size} height={size}>
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);

const EditIcon = ({ size = 16 }: { size?: number }) => (
  <svg {...iconProps} width={size} height={size}>
    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
    <path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
  </svg>
);

const TrashIcon = ({ size = 16 }: { size?: number }) => (
  <svg {...iconProps} width={size} height={size}>
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
  </svg>
);

const CloseIcon = ({ size = 16 }: { size?: number }) => (
  <svg {...iconProps} width={size} height={size}>
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);

interface ContactTypesTabProps {
  onToast: (msg: string, type?: string) => void;
}

export default function ContactTypesTab({ onToast }: ContactTypesTabProps) {
  // ─── DATA (single source of truth: the `contact_types` table) ───
  const [contactTypes, setContactTypes] = useState<{ id: string; name: string }[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // ─── CREATE MODAL STATE ───
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);

  // ─── EDIT MODAL STATE ───
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [editOldName, setEditOldName] = useState('');
  const [editName, setEditName] = useState('');
  const [saving, setSaving] = useState(false);

  // ─── DELETE MODAL STATE ───
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState(false);

  // ─── LOAD FROM SUPABASE ───
  const loadData = useCallback(async () => {
    setLoading(true);
    // Synchronize distinct contacts.contact_type values into contact_types
    // BEFORE reading the table, so every type actually present on a contact
    // (including compound values like "Existing Client (Vatsal/ Shubham)") is
    // shown. Missing values are inserted; nothing is removed or overwritten.
    await syncContactTypes();
    const [typesRes, countsRes] = await Promise.all([
      fetchContactTypes(),
      fetchContactTypeCounts(),
    ]);

    if (typesRes.error) {
      setError(typesRes.error);
      onToast('Failed to load contact types: ' + typesRes.error, 'error');
      setContactTypes([]);
    } else {
      setContactTypes(typesRes.data);
      setError(null);
    }

    if (!countsRes.error) setCounts(countsRes.data);

    setLoading(false);
  }, [onToast]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  // ─── CREATE ───
  const handleCreate = async () => {
    if (creating) return;
    if (!newName.trim()) {
      onToast('Contact type name is required', 'error');
      return;
    }
    setCreating(true);
    try {
      const { data, error } = await createContactType(newName.trim());
      if (error) {
        onToast('Failed to create contact type: ' + error, 'error');
        return;
      }
      setIsCreateOpen(false);
      setNewName('');
      onToast(`Contact type "${data?.name}" created`, 'success');
      await loadData();
    } finally {
      setCreating(false);
    }
  };

  // ─── EDIT ───
  const openEdit = (t: { id: string; name: string }) => {
    setEditId(t.id);
    setEditOldName(t.name);
    setEditName(t.name);
    setIsEditOpen(true);
  };

  const handleEditSave = async () => {
    if (saving) return;
    if (!editName.trim()) {
      onToast('Contact type name is required', 'error');
      return;
    }
    if (!editId) return;
    setSaving(true);
    try {
      const { data, error } = await renameContactType(editId, editOldName, editName.trim());
      if (error) {
        onToast('Failed to rename contact type: ' + error, 'error');
        return;
      }
      setIsEditOpen(false);
      onToast(`Contact type renamed to "${data?.name}"`, 'success');
      await loadData();
    } finally {
      setSaving(false);
    }
  };

  // ─── DELETE ───
  const openDelete = (t: { id: string; name: string }) => {
    setDeleteTarget(t);
    setIsDeleteOpen(true);
  };

  const handleDelete = async () => {
    if (deleting || !deleteTarget) return;
    setDeleting(true);
    try {
      const { error } = await deleteContactType(deleteTarget.id, deleteTarget.name);
      if (error) {
        onToast('Failed to delete contact type: ' + error, 'error');
        return;
      }
      onToast(`Contact type "${deleteTarget.name}" deleted`, 'success');
      setIsDeleteOpen(false);
      await loadData();
    } finally {
      setDeleting(false);
    }
  };

  const deleteCount = deleteTarget ? counts[deleteTarget.name] || 0 : 0;

  return (
    <div className="page active">
      {/* ─── HEADER + ACTIONS ─── */}
      <div className="contacts-head">
        <div>
          <div className="contacts-title">Contact Types</div>
          <div className="contacts-sub">
            Organize your audience into segments. These drive the tabs and filters on the Contacts page.
          </div>
        </div>
        <div className="contacts-actions">
          <button className="btn btn-primary" onClick={() => setIsCreateOpen(true)}>
            <PlusIcon size={15} /> Create Contact Type
          </button>
        </div>
      </div>

      {/* ─── MANAGEMENT PANEL ─── */}
      <div className="ct-panel">
        <div className="ct-toolbar">
          <div>
            <div className="ct-panel-title">Segments</div>
            <div className="ct-record-count">
              {contactTypes.length} {contactTypes.length === 1 ? 'type' : 'types'}
            </div>
          </div>
        </div>

        <div className="ct-table-wrap">
          <table className="ct-table" style={{ minWidth: 'unset' }}>
            <thead>
              <tr>
                <th>Name</th>
                <th style={{ width: 130 }}>Contacts</th>
                <th style={{ textAlign: 'right', width: 120 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={3}>
                    <div className="empty-state">
                      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
                        <span className="spinner"></span>
                        <span className="empty-title">Loading contact types…</span>
                      </div>
                    </div>
                  </td>
                </tr>
              ) : contactTypes.length === 0 ? (
                <tr>
                  <td colSpan={3}>
                    <div className="empty-state">
                      <div className="empty-icon">🏷️</div>
                      <div className="empty-title">No contact types yet</div>
                      <div className="empty-sub">
                        {error ? error : 'Create your first segment to start organizing contacts.'}
                      </div>
                    </div>
                  </td>
                </tr>
              ) : (
                contactTypes.map((t) => (
                  <tr key={t.id} className="ct-row">
                    <td>
                      <div className="ct-name">{t.name}</div>
                    </td>
                    <td>
                      <span className="ct-tab-count">{counts[t.name] || 0}</span>
                    </td>
                    <td>
                      <div className="ct-row-actions">
                        <button
                          title="Edit contact type"
                          onClick={() => openEdit(t)}
                          className="ct-ibtn ct-ibtn-edit"
                        >
                          <EditIcon size={15} />
                        </button>
                        <button
                          title="Delete contact type"
                          onClick={() => openDelete(t)}
                          className="ct-ibtn ct-ibtn-danger"
                        >
                          <TrashIcon size={15} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ─── MODAL: CREATE CONTACT TYPE ─── */}
      {isCreateOpen && (
        <div className="modal-overlay">
          <div className="modal">
            <div className="modal-header">
              <div>
                <div className="modal-title">Create Contact Type</div>
                <div className="ct-sub" style={{ marginTop: 3 }}>
                  Add a new segment for organizing contacts.
                </div>
              </div>
              <button className="modal-close" onClick={() => setIsCreateOpen(false)} title="Close">
                <CloseIcon size={16} />
              </button>
            </div>

            <div className="modal-body">
              <div className="form-group">
                <label>Name *</label>
                <input
                  type="text"
                  placeholder="e.g. VIP Customers"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleCreate();
                  }}
                />
              </div>
            </div>

            <div className="modal-footer">
              <button className="btn btn-ghost" onClick={() => setIsCreateOpen(false)}>
                Cancel
              </button>
              <button className="btn btn-primary" disabled={creating} onClick={handleCreate}>
                {creating ? 'Creating…' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── MODAL: EDIT CONTACT TYPE ─── */}
      {isEditOpen && (
        <div className="modal-overlay">
          <div className="modal">
            <div className="modal-header">
              <div>
                <div className="modal-title">Edit Contact Type</div>
                <div className="ct-sub" style={{ marginTop: 3 }}>
                  Rename the segment. Contacts assigned to it stay assigned.
                </div>
              </div>
              <button className="modal-close" onClick={() => setIsEditOpen(false)} title="Close">
                <CloseIcon size={16} />
              </button>
            </div>

            <div className="modal-body">
              <div className="form-group">
                <label>Name *</label>
                <input
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleEditSave();
                  }}
                />
              </div>
            </div>

            <div className="modal-footer">
              <button className="btn btn-ghost" onClick={() => setIsEditOpen(false)}>
                Cancel
              </button>
              <button className="btn btn-primary" disabled={saving} onClick={handleEditSave}>
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── MODAL: DELETE CONFIRMATION ─── */}
      {isDeleteOpen && deleteTarget && (
        <div className="modal-overlay">
          <div className="modal">
            <div className="modal-header">
              <div>
                <div className="modal-title">Delete Contact Type?</div>
                <div className="ct-sub" style={{ marginTop: 3 }}>
                  Are you sure you want to delete &quot;{deleteTarget.name}&quot;?
                </div>
              </div>
              <button className="modal-close" onClick={() => setIsDeleteOpen(false)} title="Close">
                <CloseIcon size={16} />
              </button>
            </div>

            <div className="modal-body">
              {deleteCount > 0 ? (
                <div className="ct-sub" style={{ marginTop: 0, color: 'var(--text2)' }}>
                  This contact type contains <b>{deleteCount}</b>{' '}
                  {deleteCount === 1 ? 'contact' : 'contacts'}. Deleting the contact type will remove the
                  contact type assignment, but the contacts themselves will <b>NOT</b> be deleted.
                </div>
              ) : (
                <div className="ct-sub" style={{ marginTop: 0, color: 'var(--text2)' }}>
                  No contacts are assigned to this type.
                </div>
              )}
            </div>

            <div className="modal-footer">
              <button className="btn btn-ghost" onClick={() => setIsDeleteOpen(false)}>
                Cancel
              </button>
              <button className="btn btn-danger" disabled={deleting} onClick={handleDelete}>
                {deleting ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
