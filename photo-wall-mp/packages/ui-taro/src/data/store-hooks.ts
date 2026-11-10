/* ================================================================
   React 绑定：把模块级 store 接成 hook。

   挂载时把当前状态灌进去，之后靠 emit 的广播推动（不用 context：小程序每个
   Page 是独立 React 根，context 跨不过去）。
   ================================================================ */
import { useEffect, useState } from 'react';
import type { FoodRecord } from '@photo-wall/core';

import { aggregate, subscribeAggregate, subscribeWall, wall } from './store-state.ts';
import type { AggregateState, LoadStatus, WallState } from './store-state.ts';
import { errorText } from '../api/client';
import { fetchRecord } from './store-detail.ts';

/* ---------------- hooks ---------------- */

export function useWall(): WallState {
  const [state, setState] = useState<WallState>(wall);
  useEffect(() => {
    /* 订阅接口负责"注册时立刻推一次当前状态"，所以这里不用再手动 setState(wall) */
    return subscribeWall(setState);
  }, []);
  return state;
}

export function useAggregates(): AggregateState {
  const [state, setState] = useState<AggregateState>(aggregate);
  useEffect(() => subscribeAggregate(setState), []);
  return state;
}

/** 详情/编辑页用：拉一条记录，自带 loading / 404 状态 */
export function useRecord(id: string): {
  record: FoodRecord | null;
  status: LoadStatus;
  error: string | null;
  reload: () => void;
} {
  const [record, setRecord] = useState<FoodRecord | null>(null);
  const [status, setStatus] = useState<LoadStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!id) {
      setStatus('ready');
      return;
    }
    let alive = true;
    setStatus('loading');
    fetchRecord(id)
      .then((rec) => {
        if (!alive) return;
        setRecord(rec);
        setStatus('ready');
        setError(null);
      })
      .catch((e) => {
        if (!alive) return;
        setRecord(null);
        setStatus('error');
        setError(errorText(e));
      });
    return () => {
      alive = false;
    };
  }, [id, tick]);

  return { record, status, error, reload: () => setTick((n) => n + 1) };
}
