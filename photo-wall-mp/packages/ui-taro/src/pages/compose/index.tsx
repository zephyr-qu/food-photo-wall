/* ================================================================
   贴一张 / 编辑（同一页，有 id 就进编辑态）

   信息顺序按「填的时候会想什么」排，而不是按数据字段排：
     1. 吃了什么 —— 唯一必填，其余都能空着交
     2. 照片 —— 想给这道菜配张图，紧贴着菜名
     3. 几分 —— 印象最直接的一档
     4. 店、城市 —— 要在哪吃的，两个同类项放一起
     5. 备注 —— 想多写两句时才会往下看

   ---------- 选照片（原生能力） ----------
   chooseMedia 拿到的是临时路径，重启即失效。流程：
     chooseMedia → compressImage → saveFile（本机预览用）
     → 提交时 POST /photos 上传 → 拿 photoId + https URL 写记录
   四个坑：
   · 隐私协议没同意时，基础库会挂起 chooseMedia 并触发 onNeedPrivacyAuthorization；
     没人监听就变成"点了没反应" —— 所以本页挂 PrivacyGate（utils/privacy.ts）
   · 用户拒绝过相册权限后，再点不会弹窗，只能 openSetting 引导
   · saveFile 有 10MB 上限：先 compressImage 再存；换图/放弃编辑时清掉孤儿文件
   · 上传失败**不阻断提交**：记录照写，照片继续用本机路径并提示，
     不让用户因为网络问题丢掉刚选的照片

   ---------- 多图（至多 5 张） ----------
   一条记录可以有 5 张照片；照片墙会从这 5 张里随机挑一张当那一格的主图。
   状态从「单张 photo」改成「数组 PickedPhoto[]」：
   每项记着自己的 path（本机路径或服务端 URL）和 id（服务端 photoId），
   没换图时把原来的 id 原样带回去，PATCH 才是"整体替换"而不是"追加"。
   ================================================================ */
import React, { useEffect, useRef, useState } from 'react';
import { View, Text, Input, Textarea, ScrollView, Image, Picker } from '@tarojs/components';
import Taro, { useRouter } from '@tarojs/taro';

import { addRecord, updateRecord, fetchRecord, writeErrorText } from '../../data/store';
import { USE_REMOTE_DATA } from '../../config';
import {
  provinceCatalogue,
  isLocalFilePath,
  MAX_PHOTOS,
  FIELD_LIMITS,
  stampNow,
  datePart,
  timePart,
  composeAt,
  tzOffsetNow,
  todayDate,
} from '@photo-wall/core';
import { uploadPhoto, getGeoCities, geoCitiesToGroups } from '../../api';
import { errorText, getErrorFields } from '../../api/client';
import RatingDots from '../../components/RatingDots';
import CityPicker from '../../components/CityPicker';
import PrivacyGate from '../../components/PrivacyGate';
import { previewPhoto } from '../../utils/taro';
import { registerPrivacyGate } from '../../utils/privacy';
import { discardLocalPhoto } from '../../utils/photo';
import type { FoodRecord, RecordPatch, FieldName, ProvinceGroup } from '@photo-wall/core';

import {
  appendPicked,
  collectTooLong,
  firstTooLongText,
  formatDateForDisplay,
  isFormDirty,
  isFutureMinute,
  isNowMinute,
  pickedFromRecord,
  removeByKey,
} from './helpers';
import type { PickedPhoto } from './helpers';
import { pickPhotos } from './pick-photos';

import './index.scss';

/* 纯逻辑（长度校验 / 日期 / 时间比较 / 照片回填 / 未保存判定）在 ./helpers，
   选照片（chooseMedia + 持久化 + 每种失败原因的提示）在 ./pick-photos。
   页面只留表单状态、提交编排和 JSX。 */

export default function ComposePage() {
  const router = useRouter();
  const editId = router.params.id || '';
  const editing = Boolean(editId);

  const [eat, setEat] = useState('');
  const [shop, setShop] = useState('');
  const [city, setCity] = useState('');
  const [note, setNote] = useState('');
  const [rating, setRating] = useState(0);
  /** 选中的照片（最多 5 张，有序）。空 = 用预置配图 */
  const [photos, setPhotos] = useState<PickedPhoto[]>([]);
  const [err, setErr] = useState(false);
  const [focus, setFocus] = useState(false);
  /**
   * 超长的字段（键 = 字段名）。
   *
   *  为什么要有它：服务端对每个字段都有长度上限（契约 §3.7），而
   *  `<Input maxlength>` 只能挡住「超上限的那一个」，挡不住
   *  「trim 之后超上限」（前后各一个空格就绕过去了）。
   *  以前这里既不校验长度、也不显示提示，超长提交后被服务端 422 拒掉，
   *  用户只看到一句「字段校验失败」—— 白填一遍还不知道错在哪。
   */
  const [tooLong, setTooLong] = useState<Partial<Record<FieldName, string>>>({});
  /** 服务端返回的逐字段错误（P2-5）：字段名 → 中文文案，行内红字显示。
   *  提交被 422 / 字段校验拒绝时填，刷新成功或重新提交前清空。 */
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  /** 城市选择浮层（两级：省 → 市），和照片墙共用 CityPicker。
   *  数据源走服务端 `GET /geo/cities`（与墙上 `/records/cities` 同源），
   *  本地 `provinceCatalogue()` 仅作首屏即时占位 + 拉取失败兜底，避免两份演进。 */
  const [cityPickOpen, setCityPickOpen] = useState(false);
  const [cityCatalogue, setCityCatalogue] = useState<ProvinceGroup[]>(() =>
    provinceCatalogue(),
  );

  useEffect(() => {
    let alive = true;
    getGeoCities()
      .then((data) => {
        if (alive) setCityCatalogue(geoCitiesToGroups(data));
      })
      .catch(() => {
        /* 字典拉失败就继续用本地表，不影响填表 */
      });
    return () => {
      alive = false;
    };
  }, []);

  /**
   * 吃的时间（补记）：日期 + 时刻。
   *
   *  为什么拆成两段而不是一个 `at` 字符串：`<Picker mode="date">` 的
   *  value 是 'YYYY-MM-DD'，`mode="time"` 的是 'HH:mm'，两个控件各要
   *  一种格式。合成完整 `at` 的时机只有一个 —— 提交那一刻。
   *
   *  ⚠ 两个初值必须来自**同一次**取时刻：写成两个 useState(() => ...)
   *  的话，跨过午夜那一刻会得到「今天的日期 + 明天的时刻」这种
   *  对不上的组合（差一天）。所以这里先取一次 stampNow() 再拆。
   */
  const [at, setAt] = useState(() => {
    const now = stampNow();
    return { date: datePart(now), time: timePart(now) };
  });
  /**
   * 编辑态：这条记录**原始**的 `at`（进入页面时拍的快照）。
   *
   *  用途：提交时判断「用户到底改没改时间」。
   *  没改就不发 `at`/`tzOffset` —— 否则服务端会用**当前设备**的时区
   *  重新解释这个墙钟时间。用户 8 月在纽约建的记录、10 月在东京编辑，
   *  只是改了个备注，时间瞬间被搬到 +09:00 解释，排序/分月都可能跳。
   */
  const originalAtRef = useRef<string | null>(null);

  /** 编辑态初始化：记录要从服务端拉（本地模式从 storage） */
  const [loading, setLoading] = useState(editing);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** 提交中：上传照片 + 写记录，别让用户连点两次 */
  const [submitting, setSubmitting] = useState(false);
  /** 上传进度（B4）：{done,total}；null = 不在上传阶段。
   *  5 张串行上传在弱网下可能几十秒，光一个静态「上传照片…」看不出还在不在动。 */
  const [uploadProgress, setUploadProgress] = useState<{ done: number; total: number } | null>(
    null,
  );
  /** 照片上传失败提示（B8）：展示在照片区下方；重新选图/删图/重试时清空。 */
  const [photoError, setPhotoError] = useState<string | null>(null);
  /** 打开页面时记录里已有的照片 —— 取消编辑时它必须留着 */
  const initialPhotos = useRef<PickedPhoto[]>([]);
  /** 本次会话里由本页新建的本机照片；离开页面时删掉没被保存的那些 */
  const ownedPhotos = useRef<Set<string>>(new Set());
  /** 真正写进记录的那些本机文件（不能被当成孤儿删掉） */
  const committedPhotos = useRef<Set<string>>(new Set());
  /** 编辑所基于的版本号：PATCH 时作为 If-Match（P1-4）。
   *  不能用缓存里的最新 version —— SWR 后台刷新会在编辑期间把它抬高。 */
  const loadedVersionRef = useRef<number | undefined>(undefined);
  /** 编辑态回填时的表单快照（未保存离开判定用） */
  const initialFormRef = useRef<{
    eat: string;
    shop: string;
    city: string;
    note: string;
    rating: number;
    atDate: string;
    atTime: string;
    paths: string[];
  } | null>(null);
  /** 已提交成功：锁死 submit，防止收尾窗口（600ms）内再点一次造出重复记录 */
  const doneRef = useRef(false);
  /** 成功后的自动返回定时器（卸载时清理，避免用户先手动返回后再多退一层） */
  const backTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 写成功后待回收的本机照片（在线模式）：等页面即将离开时再删，
      避免删得太早把当前页的缩略图弄裂（B7）。 */
  const pendingRecycle = useRef<string[]>([]);
  /** 当前是否已开启 weapp 的返回拦截（避免每次输入都重复调用 enable） */
  const leaveGuardOn = useRef(false);

  /** 当前表单相对初始快照是否被改过（判定规则与测试都在 ./helpers 的 isFormDirty） */
  const formDirty = (): boolean =>
    isFormDirty(
      editing,
      { eat, shop, city, note, rating, at, paths: photos.map((p) => p.path) },
      initialFormRef.current
        ? {
            eat: initialFormRef.current.eat,
            shop: initialFormRef.current.shop,
            city: initialFormRef.current.city,
            note: initialFormRef.current.note,
            rating: initialFormRef.current.rating,
            at: { date: initialFormRef.current.atDate, time: initialFormRef.current.atTime },
            paths: initialFormRef.current.paths,
          }
        : null,
    );

  /** 开/关「未保存离开」拦截。H5 的 enableAlertBeforeUnload 是
   *  temporarilyNotSupport（调用会抛），只在 weapp 生效。 */
  const syncLeaveGuard = (dirty: boolean): void => {
    if (process.env.TARO_ENV !== 'weapp') return;
    if (
      typeof Taro.enableAlertBeforeUnload !== 'function' ||
      typeof Taro.disableAlertBeforeUnload !== 'function'
    ) {
      return;
    }
    if (dirty === leaveGuardOn.current) return;
    leaveGuardOn.current = dirty;
    if (dirty) Taro.enableAlertBeforeUnload({ message: '还没保存，离开就丢了' });
    else Taro.disableAlertBeforeUnload();
  };

  /** 回收「已写进记录、本机副本不再需要」的照片（在线模式） */
  const recyclePendingPhotos = (): void => {
    const list = pendingRecycle.current;
    pendingRecycle.current = [];
    list.forEach((p) => discardLocalPhoto(p));
  };

  /* 隐私监听只注册一次（幂等）；离开页面时清掉本次产生的孤儿照片。
     注意：判定「孤儿」用的是 owned 集合，编辑态原有的照片不在里面 ——
     用户选了一张新图又放弃编辑，旧照片必须还在。 */
  useEffect(() => {
    registerPrivacyGate();
    const owned = ownedPhotos.current;
    return () => {
      owned.forEach((p) => {
        if (!committedPhotos.current.has(p)) discardLocalPhoto(p);
      });
      owned.clear();
    };
  }, []);

  /* 编辑态：拉一次记录回填。以前从本地数组 find 是同步的，
     现在可能失败 —— 失败要能重试，而不是给一个空表单让用户覆盖写。 */
  useEffect(() => {
    if (!editing) {
      Taro.setNavigationBarTitle({ title: '贴一张' });
      const t = setTimeout(() => setFocus(true), 320);
      return () => clearTimeout(t);
    }

    Taro.setNavigationBarTitle({ title: '编辑' });
    let alive = true;
    setLoading(true);
    fetchRecord(editId)
      .then((rec) => {
        if (!alive) return;
        applyRecord(rec);
        setLoading(false);
      })
      .catch((e) => {
        if (!alive) return;
        setLoadError(errorText(e));
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [editing, editId]);

  /* 未保存离开保护（P1-5）：表单有改动时拦返回/侧滑；编辑态回填期间不算改过。 */
  useEffect(() => {
    if (loading) return;
    syncLeaveGuard(formDirty());
  }, [eat, shop, city, note, rating, at, photos, loading, editing]);

  /* H5 没有 enableAlertBeforeUnload，用浏览器原生 beforeunload 兜底 */
  useEffect(() => {
    if (process.env.TARO_ENV !== 'h5' || typeof window === 'undefined') return;
    const onBeforeUnload = (e: BeforeUnloadEvent): void => {
      if (!formDirty()) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [eat, shop, city, note, rating, at, photos, loading, editing]);

  /* 卸载时清掉自动返回定时器、回收待删本机照片，并解除返回拦截
     （否则下次进页会被误拦） */
  useEffect(() => {
    return () => {
      if (backTimer.current) clearTimeout(backTimer.current);
      recyclePendingPhotos();
      syncLeaveGuard(false);
    };
  }, []);

  /**
   * 用记录回填表单。
   *
   * 为什么要单独抽出来：加载成功和"点重试"两条路径要做同一件事，
   * 以前是复制粘贴两份（改一处忘一处就会出 bug）。
   *
   * 参数直接用 FoodRecord，而不是手写一份内联结构。
   * 手写的那份把 shop/city/note 标成**必填** `string | null`，而 FoodRecord
   * 里它们是**可选**的 `string | null | undefined` —— 于是 `FoodRecord`
   * 传不进来（TS2345）。以后 core 再加字段，这里也会自动跟上，
   * 不用两处同步。
   */
  const applyRecord = (rec: FoodRecord): void => {
    setEat(rec.eat || '');
    setShop(rec.shop || '');
    setCity(rec.city || '');
    setNote(rec.note || '');
    setRating(rec.rating || 0);
    /* 编辑态要把**原记录的时间**填回日期/时刻控件。
       以前编辑时根本不能改时间（表单里没有时间字段），现在有了，
       就必须先回填 —— 否则打开编辑页的瞬间控件停在「今天」，
       用户只改了个店名就点了保存，这条记录的时间就被改成今天了。
       同时拍一份快照（originalAtRef），提交时用来判断改没改。 */
    setAt({ date: datePart(rec.at), time: timePart(rec.at) });
    originalAtRef.current = rec.at;
    /* P1-4：记住「用户编辑所基于的版本」，保存时作为 If-Match 发出 */
    loadedVersionRef.current = rec.version;

    const picked = pickedFromRecord(rec);
    initialPhotos.current = picked;
    /* 未保存离开判定的初始快照（新建态为 null，按"有没有填过"判） */
    initialFormRef.current = {
      eat: rec.eat || '',
      shop: rec.shop || '',
      city: rec.city || '',
      note: rec.note || '',
      rating: rec.rating || 0,
      atDate: datePart(rec.at),
      atTime: timePart(rec.at),
      paths: picked.map((p) => p.path),
    };
    setPhotos(picked);
  };

  /**
   * 清掉某个字段的超长提示。
   *
   *  为什么要单独抽：用户改正的时候，那条红字必须**马上**消失 ——
   *  留着就变成「已经改好了还在报错」。
   */
  const clearTooLong = (field: FieldName): void => {
    setTooLong((prev) => {
      if (!prev[field]) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });
  };

  /**
   * 清掉某个字段的服务端逐字段错误（B9）。
   *
   * 和 clearTooLong 同一个道理：用户改正后红字必须**立刻**消失，
   * 否则会出现「已经改好了还在报错」，让人不知道该信谁。
   */
  const clearFieldError = (field: string): void => {
    setFieldErrors((prev) => {
      if (!(field in prev)) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });
  };

  const onPickPhoto = async (): Promise<void> => {
    /* 提交期间不允许再选图：本次 photoIds 已定稿，新图不会进记录（B3） */
    if (submitting || photos.length >= MAX_PHOTOS) return;
    setPhotoError(null);
    clearFieldError('photoIds');
    const picked = await pickPhotos(photos.length, MAX_PHOTOS);
    if (!picked || !picked.length) return;
    const room = MAX_PHOTOS - photos.length;
    /* 只在换图时立刻删除旧文件：用户可能马上返回、不保存，
       那样旧记录会指向一张已被删掉的图。统一在提交/卸载时清理。 */
    picked.slice(0, room).forEach((path) => ownedPhotos.current.add(path));
    setPhotos((prev) => appendPicked(prev, picked, MAX_PHOTOS));
  };

  const onPreviewPhoto = (p: PickedPhoto): void => {
    previewPhoto(p.path);
  };

  /** 删掉一张：立刻清掉它的本机文件（它已经不会被写进记录了） */
  const onRemovePhoto = (target: PickedPhoto): void => {
    /* 提交期间不允许删图：本次 photoIds 已定稿，删了只会在服务端留下孤儿照片（B3） */
    if (submitting) return;
    setPhotoError(null);
    clearFieldError('photoIds');
    setPhotos((prev) => removeByKey(prev, target.key));
    /* 被删掉的本机文件立刻清 —— 它已经不可能进记录了，留着只是白占配额。
       服务端 URL 不动（discardLocalPhoto 内部只删本机文件）。 */
    if (isLocalFilePath(target.path)) discardLocalPhoto(target.path);
    ownedPhotos.current.delete(target.path);
  };

  const submit = async (): Promise<void> => {
    /* doneRef：写成功后到自动返回前的窗口里，按钮已经恢复可点 —— 必须锁死，
       否则再点一次就是第二条重复记录（B1） */
    if (submitting || doneRef.current) return;

    /* ⚠ 编辑态的加载闸：记录还没拉回来时**不能提交**。
       以前这里没有这道闸，用户在慢网下点「保存」，表单里的 shop/city/note
       还是空的 → PATCH 把原记录的这些字段全写成 null、photoIds 写成 []，
       等于「保存」=「清空这条记录」。加载失败时给的是重试按钮，
       而不是空表单，就是为了避开这个坑 —— 但提交按钮当时仍然可点。 */
    if (editing && loading) {
      Taro.showToast({ title: '正在加载这条记录，请稍候', icon: 'none', duration: 1800 });
      return;
    }

    const v = eat.trim();
    if (!v) {
      setErr(true);
      setFocus(true);
      return;
    }

    /* 长度校验：与服务端同一份上限（core 的 FIELD_LIMITS）。
       放在提交前而不是提交后 —— 超长就本地拦下并指到具体字段，
       用户不用白跑一趟请求、也不用猜「字段校验失败」说的是哪一项。
       ⚠ 编辑态还没把记录拉回来时不能提交（见下面的 loading 闸），
       否则会把原记录的字段全部写成 null。 */
    const bad = collectTooLong({ eat: v, shop, city, note });
    if (Object.keys(bad).length > 0) {
      setTooLong(bad);
      Taro.showToast({ title: firstTooLongText(bad), icon: 'none', duration: 2200 });
      return;
    }
    setTooLong({});
    setFieldErrors({}); // P2-5：提交前清掉上一次的逐字段红字
    setPhotoError(null);

    /* B9：未来时间在本地先拦下（服务端也会 422「不能是未来时间」）。 */
    if (isFutureMinute(at)) {
      Taro.showToast({ title: '不能是未来时间', icon: 'none', duration: 2200 });
      return;
    }

    setSubmitting(true);
    /* 最终写进记录的 photoId 列表（按界面顺序） */
    const photoIds: string[] = [];
    let failedCount = 0;
    /* 第一条上传失败的原因（给用户一句能照做的提示） */
    let failedReason = '';
    /* 上传成功后的服务端 URL（用来填 record.photo；只是这 5 张里的一张，
       墙上最终显示哪一张由墙上的随机种子决定） */
    let coverUrl: string | null = null;
    /* 是否已经 showLoading：hide 必须成对，且要等"写记录"也结束才调用（B3） */
    let loadingShown = false;

    try {
      /* 逐张上传本机路径 → photoId。
         已有 id 的（编辑态没换图的那几张）直接沿用，不用重传。 */
      const needsUpload = photos.filter((p) => !p.id && isLocalFilePath(p.path));
      const totalUpload = needsUpload.length;
      let uploadDone = 0;
      /** 上传进度：showLoading 的标题与提交按钮文案都跟着它走（B4） */
      const tick = (): void => {
        if (!totalUpload) return;
        setUploadProgress({ done: uploadDone, total: totalUpload });
        Taro.showLoading({ title: `上传照片 ${uploadDone}/${totalUpload}`, mask: true });
      };
      if (totalUpload) {
        loadingShown = true;
        tick();
      }

      for (const p of photos) {
        if (p.id) {
          photoIds.push(p.id);
          if (!coverUrl) coverUrl = p.path;
          continue;
        }
        if (!isLocalFilePath(p.path)) {
          /* 既没有 id 又不是本机文件（理论上不会发生）：当成失败处理，
             别把一个服务端不认的路径写进 photoIds。 */
          failedCount += 1;
          uploadDone += 1;
          tick();
          continue;
        }
        try {
          const uploaded = await uploadPhoto(p.path);
          photoIds.push(uploaded.photoId);
          /* 立刻把 photoId 回写到 state（B2）：写记录失败后用户重试时，
             这张会被 `!p.id` 过滤掉、不再重传一遍（否则流量翻倍 + 服务端孤儿照片）。 */
          setPhotos((prev) =>
            prev.map((q) => (q.key === p.key ? { ...q, id: uploaded.photoId } : q)),
          );
          if (!coverUrl) {
            /* 用服务端给的两个 URL 里的展示图（photo，约 1080w）；
               列表场景服务端另有 photoThumb，由数据层决定用哪个 */
            coverUrl = uploaded.photo || uploaded.url || p.path;
          }
        } catch (e) {
          /* 记住原因：413「照片太大」/ 415「格式不对」/ 422「没过审核」
             各有各的解法，全吞成「有 N 张没传上去」用户不知道该换一张还是压缩。 */
          failedCount += 1;
          if (!failedReason) failedReason = errorText(e);
        }
        uploadDone += 1;
        tick();
      }

      /* B8：只要有一张没传上去，就**不写记录**（不再"部分保存"）。
         已成功的 id 已回写进表单（B2），重试只补传失败的那几张；
         想放弃就删掉失败的那几张再保存。这样不会出现"保存成功但少了图"
         这种静默丢失，也不用事后去服务端补。 */
      if (failedCount > 0) {
        setUploadProgress(null);
        if (loadingShown) Taro.hideLoading();
        loadingShown = false;
        const msg = failedReason
          ? `有 ${failedCount} 张照片没传上去：${failedReason}。请重试，或删掉这几张再保存`
          : `有 ${failedCount} 张照片没传上去。请重试，或删掉这几张再保存`;
        setPhotoError(msg);
        Taro.showToast({
          title: failedReason ? `有 ${failedCount} 张没传上去：${failedReason}` : '有照片没传上去，请重试',
          icon: 'none',
          duration: 3000,
        });
        return;
      }
      setUploadProgress(null);

      /* ⚠ 这里**不能** hideLoading：上传结束不等于提交结束。
         写记录（PATCH/POST + 随后的 refreshAll）在弱网下还要几秒，
         这期间页面必须继续被遮罩挡住 —— 否则用户加/删照片不进本次 photoIds，
         会被当成"已保存"静默丢掉（B3）。hideLoading 挪到写成功后。 */

      /* 时间：把日期 + 时刻拼成契约要求的本地墙钟串，并带上设备时区。
         ⚠ `at` 必须成对发 `tzOffset`：服务端拿 `at` + `tzOffset` 才能
         算出正确的 UTC instant 用于排序。用户在纽约时（UTC-5）如果只发
         `at` 不发偏移，服务端会按默认 +08:00 解释 —— 时间差 13 小时，
         排序全乱。所以这两个字段必须**一起**发，不能只发 at。 */
      const atLocal = composeAt(at.date, at.time);
      const tzOffset = tzOffsetNow();

      if (editing) {
        /* ⚠ 只有用户**真的改了时间**才发 at/tzOffset（见 originalAtRef）：
           没改就让 PATCH 不带时间字段 —— 否则服务端会拿**当前设备**的
           时区重新解释原墙钟，跨时区之后改个备注都会把记录的绝对时刻
           挪走（排序/分月跟着跳）。 */
        const atChanged = atLocal !== originalAtRef.current;
        const patch: RecordPatch = {
          eat: v,
          shop: shop.trim() || null,
          city: city.trim() || null,
          note: note.trim() || null,
          rating,
          photo: coverUrl,
          ...(atChanged ? { at: atLocal } : {}),
        };
        /* PATCH 的 photoIds 是**整体替换**：发完整列表（空数组 = 清空）。
           少了这个字段服务端就不知道用户删掉了哪张。 */
        await updateRecord(editId, patch, {
          photoIds,
          tzOffset: atChanged ? tzOffset : undefined,
          /* P1-4：用回填时记下的版本，而不是缓存里可能已被后台刷新抬高的版本 */
          version: loadedVersionRef.current,
        });
      } else {
        await addRecord(
          {
            eat: v,
            shop: shop.trim() || null,
            city: city.trim() || null,
            note: note.trim() || null,
            rating,
            photo: coverUrl,
            photos: photos.map((p) => p.path),
          },
          { photoIds, at: atLocal, tzOffset },
        );
      }

      /* 写成功后回收本机照片文件（B7）：
         · 在线模式：照片已经上传成服务端 URL，`wx.saveFile` 副本不再被任何记录引用，
           不回收的话 10MB 配额会被逐条记录吃满，之后每次选图都失败。
           这里只登记、等页面即将离开时再删 —— 立刻删会让当前页缩略图裂开。
         · 纯本地演示模式：记录里存的就是本机路径，只删「没进记录」的那些。 */
      if (USE_REMOTE_DATA) {
        const toRecycle = new Set<string>();
        photos.forEach((p) => {
          if (isLocalFilePath(p.path)) toRecycle.add(p.path);
        });
        initialPhotos.current.forEach((p) => {
          if (isLocalFilePath(p.path)) toRecycle.add(p.path);
        });
        ownedPhotos.current.forEach((p) => toRecycle.add(p));
        pendingRecycle.current = [...toRecycle];
      } else {
        const kept = new Set<string>();
        photos.forEach((p) => {
          if (isLocalFilePath(p.path)) kept.add(p.path);
        });
        initialPhotos.current.forEach((p) => {
          if (isLocalFilePath(p.path) && !kept.has(p.path)) discardLocalPhoto(p.path);
        });
        ownedPhotos.current.forEach((p) => {
          if (!kept.has(p)) discardLocalPhoto(p);
        });
      }
      ownedPhotos.current.clear();
      photos.forEach((p) => committedPhotos.current.add(p.path));

      /* 写记录也结束了，这时才收起遮罩 */
      if (loadingShown) Taro.hideLoading();

      /* 已经写成功：锁死提交按钮（防止收尾窗口内再点一次造出重复记录），
         并解除未保存离开拦截（否则下面的自动返回会被自己拦住）。 */
      doneRef.current = true;
      syncLeaveGuard(false);

      /* 走到这里说明所有照片都传上去了（B8 会让"有失败"提前 return），
         toast 只说结果即可。 */
      Taro.showToast({
        title: editing ? '已保存' : '贴上了',
        icon: 'none',
        duration: 1200,
      });
      if (backTimer.current) clearTimeout(backTimer.current);
      backTimer.current = setTimeout(() => {
        /* 先回收本机副本，再离开（B7）；页面若被用户手动返回，由卸载 cleanup 兜底 */
        recyclePendingPhotos();
        Taro.navigateBack();
      }, 600);
    } catch (e) {
      /* 写失败：保留表单内容，让用户能重试（不 navigateBack）。
         离线时 writeErrorText 给的是"联网后再点一次"，不是泛泛的"操作失败"。 */
      setUploadProgress(null);
      if (loadingShown) Taro.hideLoading();
      /* P2-5：若服务端带了逐字段校验（422 / 写记录字段错误），把文案沉淀到
         表单行内红字，而不只是一条笼统 toast —— 用户能直接看到「菜名」「店名」
         各自哪里不对。 */
      setFieldErrors(getErrorFields(e));
      Taro.showToast({ title: writeErrorText(e), icon: 'none', duration: 2600 });
    } finally {
      setSubmitting(false);
    }
  };

  /* 编辑态加载中：空白表单的提交按钮是可点的（submit() 里有 loading 闸兜底，
     不会真的覆盖原记录），但用户看到的是「菜名/店名/照片全空」的表单，
     体验上像「记录丢了」。这里给一个明确的加载态，而不是一个空壳表单。 */
  if (editing && loading && !loadError) {
    return (
      <View className="cp cp--loading">
        <View className="cp__loading">
          <Text className="cp__loading-t">正在加载这条记录…</Text>
        </View>
      </View>
    );
  }

  /* 编辑态加载失败：给重试，而不是一个空表单（空表单提交会覆盖原记录） */
  if (editing && loadError && !loading) {
    return (
      <View className="cp cp--fail">
        <Text className="cp__fail-t">{loadError}</Text>
        <View
          className="btn btn--quiet"
          onClick={() => {
            setLoadError(null);
            setLoading(true);
            fetchRecord(editId)
              .then((rec) => {
                applyRecord(rec);
              })
              .catch((e) => setLoadError(errorText(e)))
              .finally(() => setLoading(false));
          }}
        >
          <Text>重试</Text>
        </View>
      </View>
    );
  }

  return (
    <View className="cp">
      <ScrollView className="cp__scroll" scrollY>
        <View className="cp__body">
          {/* 1. 吃了什么 —— 必填，也是唯一会报错的一项。
              maxlength 与服务端一致（core 的 FIELD_LIMITS.eat = 60）：
              不写的话生效的是 Taro 框架默认的 140，用户能输入能提交，
              然后被服务端 422 拒掉，错误提示还只是一句「字段校验失败」。 */}
          <View className="field">
            <View className="field__row">
              <Text className="field__label">这一口</Text>
              <Text className="field__count">{eat.trim().length}/{FIELD_LIMITS.eat}</Text>
            </View>
            <Input
              className="field__input field__input--lead"
              value={eat}
              focus={focus}
              placeholder="比如 甜水面"
              placeholderClass="field__ph"
              cursorSpacing={120}
              maxlength={FIELD_LIMITS.eat}
              onInput={(e) => {
                setEat(e.detail.value);
                if (err && e.detail.value.trim()) setErr(false);
                clearTooLong('eat');
                clearFieldError('eat');
              }}
            />
            {err && <Text className="field__err">这一口不能空着</Text>}
            {tooLong.eat && <Text className="field__err">{tooLong.eat}</Text>}
            {fieldErrors.eat && <Text className="field__err">{fieldErrors.eat}</Text>}
          </View>

          {/* 2. 照片 —— 可选，最多 5 张。
              照片墙会从这 5 张里随机挑一张当那一格的主图（不是固定第 1 张），
              所以这里不再标「封面」。
              BRIEF 的字段顺序是 菜名→评分→店→城市→备注，
              照片没有指定位置；放在菜名之后是刻意的：
              选完菜就配图，比填完一堆字再回头找图更顺。

              横向缩略图条：每张 160rpx 方块，点开看大图、右上角 × 删掉，
              末尾一个「＋选照片」方块（满 5 张自动消失）。 */}
          <View className="field">
            <View className="field__row">
              <Text className="field__label">
                贴上照片{photos.length > 1 ? `（${photos.length}/${MAX_PHOTOS}）` : ''}
              </Text>
            </View>
            <ScrollView className="shots" scrollX>
              <View className="shots__row">
                {photos.map((p) => (
                  <View key={p.key} className="shot">
                    <Image
                      className="shot__img"
                      src={p.path}
                      mode="aspectFill"
                      onClick={() => onPreviewPhoto(p)}
                    />
                    {/* 不标「封面」：墙上随机取一张，第 1 张不再特殊 */}
                    <View
                      className={'shot__x' + (submitting ? ' shot__x--off' : '')}
                      onClick={() => {
                        /* 提交期间禁止删图：本次 photoIds 已定稿，删了只会在
                           服务端留下没人引用的照片（B3 的第二道防线） */
                        if (!submitting) onRemovePhoto(p);
                      }}
                    >
                      {/* 外层是 36px 的透明热区，内层才是 20px 的视觉方块（B10） */}
                      <View className="shot__x-in">
                        <Text>×</Text>
                      </View>
                    </View>
                  </View>
                ))}
                {/* 满了就不再显示「＋」——上限是硬约束；提交期间也不给加图，
                    否则新图不进本次 photoIds、保存后被当成孤儿删掉（B3） */}
                {photos.length < MAX_PHOTOS && !submitting ? (
                  <View className="shot shot--add" onClick={onPickPhoto}>
                    <Text className="shot__plus">＋</Text>
                    <Text className="shot__addt">选照片</Text>
                  </View>
                ) : null}
              </View>
            </ScrollView>
            {photos.length === 0 ? (
              <Text className="shots__hint">没选照片会用默认配图</Text>
            ) : null}
            {/* B8：上传失败的说明（含原因与"重试或删掉"的指引） */}
            {photoError && <Text className="field__err">{photoError}</Text>}
            {fieldErrors.photoIds && <Text className="field__err">{fieldErrors.photoIds}</Text>}
          </View>

          {/* 3. 几分意 —— 再点同一档可取消（取消逻辑在 RatingDots 里） */}
          <View className="field">
            <Text className="field__label">几分意</Text>
            <View className="rate">
              <RatingDots
                value={rating}
                size="md"
                theme="light"
                onSelect={setRating}
              />
              <Text className="rate__v">{rating ? `${rating} 分` : '没打分'}</Text>
            </View>
          </View>

          {/* 4. 何时 —— 补记。
              默认就是「现在」，绝大多数情况不用碰；真要补记（上周三吃的）
              才点开改。
              ⚠ 为什么放在评分之后、店名之前：时间是「这条记录的事实」，
              跟菜名是一组的；而「在哪吃」是另一组。 */}
          <View className="field">
            <View className="field__row">
              <Text className="field__label">何时</Text>
              {/* 今天且是当前这一分钟 → 标一句「现在」，让用户知道
                  不改就是此刻，省得对着控件犹豫。 */}
              {isNowMinute(at) ? <Text className="field__count">现在</Text> : null}
            </View>
            <View className="when">
              <Picker
                mode="date"
                className="when__pick"
                value={at.date}
                /* 不能选未来：服务端会 422「不能是未来时间」，
                   与其提交后才被拒，不如直接不让选。
                   ⚠ end 用今天而不是「今天+1」：Picker 的 end 是**含**的，
                   给 '今天+1' 会让明天也能选。 */
                end={todayDate()}
                onChange={(e) => {
                  setAt((prev) => ({ ...prev, date: e.detail.value }));
                  clearFieldError('at');
                }}
              >
                <View className="when__cell">
                  <Text className="when__v">{formatDateForDisplay(at.date)}</Text>
                  <Text className="when__k">日期</Text>
                </View>
              </Picker>
              <Picker
                mode="time"
                className="when__pick"
                value={at.time}
                onChange={(e) => {
                  setAt((prev) => ({ ...prev, time: e.detail.value }));
                  clearFieldError('at');
                }}
              >
                <View className="when__cell">
                  <Text className="when__v">{at.time}</Text>
                  <Text className="when__k">时刻</Text>
                </View>
              </Picker>
            </View>
            {/* 日期被改到今天之前、时刻却是未来（比如选了昨天但时刻是 23:00，
                那其实是昨天 23:00，没问题）—— 这里只提示「未来的时刻」：
                今天选了比现在还晚的时刻，提交会被服务端拒。 */}
            {isFutureMinute(at) ? (
              <Text className="field__err">不能是未来时间</Text>
            ) : null}
            {fieldErrors.at && <Text className="field__err">{fieldErrors.at}</Text>}
          </View>

          {/* 5. 在哪吃的 —— 两个同类项，标签与输入各占一行 */}
          <View className="field">
            <View className="field__row">
              <Text className="field__label">哪一家</Text>
              <Text className="field__count">{shop.trim().length}/{FIELD_LIMITS.shop}</Text>
            </View>
            <Input
              className="field__input"
              value={shop}
              placeholder="店名，没记下就空着"
              placeholderClass="field__ph"
              cursorSpacing={120}
              maxlength={FIELD_LIMITS.shop}
              onInput={(e) => {
                setShop(e.detail.value);
                clearTooLong('shop');
                clearFieldError('shop');
              }}
            />
            {tooLong.shop && <Text className="field__err">{tooLong.shop}</Text>}
            {fieldErrors.shop && <Text className="field__err">{fieldErrors.shop}</Text>}
          </View>

          <View className="field">
            <Text className="field__label">在哪座城</Text>
            {/* 只选不填：点开是全量城市表（省 → 市），表外的城市不在这里 ——
                想记就记能选到的那些，「不记城市」留一个出口 */}
            <View className="select" onClick={() => setCityPickOpen(true)}>
              <Text className={city ? 'select__v' : 'select__v select__v--ph'}>
                {city || '比如 成都'}
              </Text>
              <Text className="select__chev">›</Text>
            </View>
            {fieldErrors.city && <Text className="field__err">{fieldErrors.city}</Text>}
          </View>

          {/* 5. 想记两句 */}
          <View className="field field--last">
            <View className="field__row">
              <Text className="field__label">想记两句</Text>
              <Text className="field__count">{note.trim().length}/{FIELD_LIMITS.note}</Text>
            </View>
            <Textarea
              className="field__area"
              value={note}
              placeholder="想写就写"
              placeholderClass="field__ph"
              maxlength={FIELD_LIMITS.note}
              autoHeight
              onInput={(e) => {
                setNote(e.detail.value);
                clearTooLong('note');
                clearFieldError('note');
              }}
            />
            {tooLong.note && <Text className="field__err">{tooLong.note}</Text>}
            {fieldErrors.note && <Text className="field__err">{fieldErrors.note}</Text>}
          </View>
        </View>
      </ScrollView>

      {/* 城市选择：底部上滑的两级抽屉（省 → 市），选完回填输入框 */}
      <CityPicker
        open={cityPickOpen}
        variant="sheet"
        hint="选择城市"
        groups={cityCatalogue}
        showCounts={false}
        allowNone
        city={city.trim() || null}
        onPick={(c) => {
          setCity(c ?? '');
          clearFieldError('city');
          setCityPickOpen(false);
        }}
        onClose={() => setCityPickOpen(false)}
      />

      {/* 隐私授权：只在用户第一次选图、且还没同意过隐私协议时升起。
          同意按钮必须是 open-type="agreePrivacyAuthorization"（见组件内注释）。 */}
      <PrivacyGate />

      {/* 提交按钮文案对齐 BRIEF：「贴 上 去」（不是「贴上」）。
          编辑态是「保存」——那是对已有内容的修改，用"贴上去"不合语义。
          提交中显示「上传中 N/M」或「保存中…」防连点（B4 进度）。 */}
      <View className="bar">
        <View
          className={'btn btn--primary bar__main' + (submitting ? ' btn--busy' : '')}
          onClick={submit}
        >
          <Text>
            {submitting
              ? uploadProgress
                ? `上传中 ${uploadProgress.done}/${uploadProgress.total}`
                : '保存中…'
              : editing
                ? '保存'
                : '贴 上 去'}
          </Text>
        </View>
      </View>
    </View>
  );
}
