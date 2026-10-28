'use client';
import { createContext, useContext } from 'react';

/** 节点卡片上的展开/收起按钮通过 context 回调,避免把函数塞进 node.data 破坏 memo */
export const ToggleContext = createContext<(id: string) => void>(() => {});
export const useToggle = () => useContext(ToggleContext);
