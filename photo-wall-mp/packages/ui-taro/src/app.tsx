import { Component } from 'react';
import type { PropsWithChildren } from 'react';
import './app.scss';

class App extends Component<PropsWithChildren> {
  render() {
    // Taro 4 的 App 只需要返回 children
    return this.props.children;
  }
}

export default App;
