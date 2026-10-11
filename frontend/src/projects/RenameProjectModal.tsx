/**
 * 重命名项目的弹窗。
 */
import React, { useState } from 'react';
import { api, errorMessage } from '../api/client';
import type { ProjectState, ProjectSummary } from '../api/types';
import { Button, Field, Input, Modal, useToast } from '../ui';

const FORM_ID = 'rename-project-form';
const MAX_NAME = 80;

interface RenameProjectModalProps {
  open: boolean;
  /** 要改名的项目；弹窗收起的动画期间继续保留上一个 */
  project: ProjectSummary | null;
  onClose: () => void;
  /** 改名成功后回调最新的项目状态 */
  onRenamed: (state: ProjectState) => void;
}

export function RenameProjectModal({ open, project, onClose, onRenamed }: RenameProjectModalProps) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  // 每次打开都从项目当前的名称开始（在渲染阶段同步，输入框一出现就是对的值）
  const [wasOpen, setWasOpen] = useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open && project) {
      setName(project.name);
      setError('');
    }
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!project || saving) return;
    const next = name.trim();
    if (!next) {
      setError('项目名称不能为空');
      return;
    }
    if (next === project.name) {
      onClose();
      return;
    }
    setSaving(true);
    try {
      const state = await api.patchProject(project.id, { name: next });
      onRenamed(state);
      toast.success('项目已重命名');
      onClose();
    } catch (e) {
      setError(errorMessage(e, '重命名失败，请重试'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => {
        if (!saving) onClose();
      }}
      size="sm"
      title="重命名项目"
      footer={
        <>
          <Button variant="ghost" disabled={saving} onClick={onClose}>
            取消
          </Button>
          <Button type="submit" form={FORM_ID} variant="primary" loading={saving} disabled={!name.trim()}>
            保存
          </Button>
        </>
      }
    >
      <form id={FORM_ID} onSubmit={(event) => void submit(event)}>
        <Field label="项目名称" error={error} hint="只改这里显示的名字，不影响招标文件和已经写好的正文。">
          <Input
            data-autofocus
            value={name}
            maxLength={MAX_NAME}
            placeholder="例如：智慧园区综合管理平台投标"
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => {
              setName(event.target.value);
              if (error) setError('');
            }}
          />
        </Field>
      </form>
    </Modal>
  );
}
