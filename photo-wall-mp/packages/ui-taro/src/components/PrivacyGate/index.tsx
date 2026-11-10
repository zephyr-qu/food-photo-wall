/* ================================================================
   隐私授权弹窗（隐私保护提示）

   只在「用户第一次用相册/相机、还没同意过隐私协议」时弹出：
   触发者是 utils/privacy.ts 里注册的 onNeedPrivacyAuthorization。

   设计要求（微信审核也会看）：
   · 必须说清楚**用在哪、用来干什么**，不能只写「同意隐私协议」；
   · 同意按钮必须是 open-type="agreePrivacyAuthorization" 的 <Button>，
     基础库会校验它确实被点过（所以 resolve 要带它的 id）；
   · 不同意也要有出口，且不能点遮罩就悄悄关掉（必须显式选择）。
   ================================================================ */
import React, { useEffect, useState } from 'react';
import { View, Text, Button } from '@tarojs/components';

import {
  subscribePrivacyGate,
  isPrivacyGateOpen,
  privacyContractName,
  agreePrivacy,
  disagreePrivacy,
  openPrivacyContract,
} from '../../utils/privacy';

import './index.scss';

/** 同意按钮的 id：utils/privacy.ts 调 resolve 时要原样带回去。 */
const AGREE_BUTTON_ID = 'privacy-agree-btn';

export default function PrivacyGate() {
  const [open, setOpen] = useState(isPrivacyGateOpen());

  useEffect(() => subscribePrivacyGate(() => setOpen(isPrivacyGateOpen())), []);

  /* H5 / 旧基础库：没有隐私授权这回事，不渲染任何东西 */
  if (process.env.TARO_ENV !== 'weapp' || !open) return null;

  return (
    <View className="pg">
      {/* 遮罩不响应点击：必须显式选「同意」或「暂不使用」 */}
      <View className="pg__mask" />
      <View className="pg__sheet">
        <View className="pg__handle" />

        <Text className="pg__title">隐私保护提示</Text>

        <Text className="pg__body">
          为了让你能给每道菜贴一张照片，需要访问你的相册或相机。请阅读并同意
          <Text className="pg__link" onClick={openPrivacyContract}>
            《{privacyContractName()}》
          </Text>
          后继续。
        </Text>

        <Text className="pg__note">
          只在你主动选图时读取你选中的那一张，不会扫描整个相册；照片存在你自己的记录里。
        </Text>

        <View className="pg__acts">
          <View className="pg__act" onClick={disagreePrivacy}>
            <Text>暂不使用</Text>
          </View>
          <Button
            id={AGREE_BUTTON_ID}
            className="pg__act pg__act--primary"
            openType="agreePrivacyAuthorization"
            hoverClass="none"
            onAgreePrivacyAuthorization={() => agreePrivacy(AGREE_BUTTON_ID)}
          >
            <Text>同意并继续</Text>
          </Button>
        </View>
      </View>
    </View>
  );
}
