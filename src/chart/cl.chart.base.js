'use strict'

// //////////////////////////////////////////////////
// 以下是ClChart的实体定义
// 一般只用操作这个类就可以实现功能了
// 一个ClChart类只是调度框架下所属的Chart的画图，鼠标键盘事件，并不存储数据
// 多图联动时，子图都到这里来获取相关信息。
// //////////////////////////////////////////////////

import {
  copyJsonOfDeep,
  formatInfo,
  inArray,
} from '../util/cl.tool';
import ClChartButton from './cl.chart.button';
import ClChartLine from './cl.chart.line';
import ClChartOrder from './cl.chart.order';
import ClChartScroll from './cl.chart.scroll';
import getValue from '../data/cl.data.tools';
import { setColor, _systemInfo } from '../cl.chart';

const CFG_LINKINFO = {
  showMode: 'last',
  // 'last' 以最新数据为定位，maxIndex=-1 表示显示最新的数据
  // ‘move’ 当发生移动就设置该参数，-- 可能不需要
  // fixed 固定显示一定范围的 分时图和5日线这一类固定数量的显示模式
  // locked 指定某条记录放中间位置
  fixed: {   // 对应fixed模式
    min: -1, // 最小记录, 为-1表示最小记录加上left
    max: -1, // 最大记录, 为-1表式最大记录减去right
    left: 20,
    right: 20
  },
  locked: {  // 只有当showMode==‘locked’模式才有作用
    index: -1, // 当前锁定的记录号，
    set: 0.5   // 表示锁定在中间，1表示锁定在最后一条记录，当前记录的百分比
  },
  minIndex: -1, // 当前画面的起始记录号 -1 表示第一次
  maxIndex: -1, // 当前画面的最大记录号 -1 表示第一次
  hotIndex: -1, // 循环时需要定位当前数据的指针定位
  moveIndex: -1, // 当前鼠标所在位置的记录号 -1 表示没有鼠标事件或第一次
  spaceX: 1, // 每个数据的间隔像素，可以根据实际情况变化，但不能系统参数里设定的spaceX小
  unitX: 5, // 每天数据的宽度 默认为5， 可以在1..50之间切换
  rightMode: 'no', // 除权模式
  hideInfo: false  // 是否显示价格
};

// 必须包含 context，其他初始化信息参考_initSystem
function ClChart(context) {
  // 必须设置context
  this.context = context;
  // 通过这个来判断是否为根
  this.father = undefined;

  // //////////////////////////////////////////////
  // 重新初始化Chart，会清理掉所有的图表和数据
  // //////////////////////////////////////////////
  this.initChart = function (dataLayer, eventLayer) {
    // linkInfo 是所有子chart公用的参数集合，也是datalayer应用的集合
    this.linkInfo = copyJsonOfDeep(CFG_LINKINFO);
    // 初始化子chart为空
    this.childCharts = {};
    // 设置数据层，同时对外提供设置接口
    this.setDataLayer(dataLayer);
    // 设置事件层，同时对外提供设置接口
    this.setEventLayer(eventLayer);
  }

  this.getChart = function (key) {
    return this.childCharts[key];
  }
  // //////////////////////////////////////////////
  // 以下是设置chart的事件关联接口，element表示映射的chart类
  // 所有事件由外部获取事件后传递到eventLayer后，再统一分发给相应的图表
  // eventLayer中有针对html5的鼠标键盘事件处理接口，其他事件处理接口另外再做
  // ////////////////////////////////////////////
  this.getEventLayer = function () {
    return this.eventLayer;
  }
  this.setEventLayer = function (layer) {
    if (layer === undefined) return;
    this.eventLayer = layer;
    this.eventLayer.bindChart(this); // 把chart绑定到事件处理层
  }
  // this.bindEvent = function (chart) {
  //   this.eventLayer.bindEvent(chart);
  // }
  // //////////////////////////////////////////////
  // 下面是绑定数据层，engine
  // //////////////////////////////////////////////
  this.getDataLayer = function () {
    return this.datalayer;
  }
  this.setDataLayer = function (layer) {
    if (layer === undefined) return;
    this.datalayer = layer;
    layer.father = this; // 告诉数据层
    this.static = this.datalayer.static;
  }
  // 设置对应的chart基本的数据key
  this.bindData = function (chart, key) {
    if (chart.hotKey !== key) {
      this.linkInfo.showMode = 'last'; // 切换数据后需要重新画图
      this.linkInfo.minIndex = -1;
      chart.hotKey = key; // hotKey 针对chart的数据都调用该数据源
      this.fastDrawEnd(); // 热点数据改变，就重新计算
    }
  }
  // 以下是客户端设置data中数据的接口
  this.setData = function (key, fields, value) {
    let info = value;
    if (typeof value === 'string') info = JSON.parse(value);
    this.datalayer.setData(key, fields, info);
    this.fastDrawEnd(); // 新的数据被设置，就重新计算
  }
  // 按key获取一个数组数据
  this.getData = function (key) {
    if (this.fastDraw) {
      if (this.fastBuffer[key] !== undefined) {
        return this.fastBuffer[key];
      }
    }
    const out = this.datalayer.getData(key, this.linkInfo.rightMode);
    if (this.fastDraw) {
      this.fastBuffer[key] = out;
    }
    return out;
  }
  this.readyData = function (data, lines) {
    for (let k = 0; k < lines.length; k++) {
      if (lines[k].ds === undefined || lines[k].ds.mode !== 'formula') continue;
      if (!this.fastDraw || (this.fastDraw && this.fastBuffer[lines[k].ds.key] === undefined)) {
        this.datalayer.makeLineData(
          { data, minIndex: this.linkinfo.minIndex, maxIndex: this.linkinfo.maxIndex },
          lines[k].formula.key,
          lines[k].formula.command
        );
      }
    }
  }
  // 按记录索引根据keys获取一组数据，数据为{MA:[]...} 主要提供给鼠标移动
  this.getMoveData = function (lines, index) {
    const out = [];
    if (!Array.isArray(lines)) return out;

    index -= this.linkInfo.minIndex;
    let value, info;
    for (let k = 0; k < lines.length; k++) {
      if (lines[k].info === undefined) continue;
      if (lines[k].info.label !== undefined) {
        if (lines[k].ds === undefined || lines[k].ds.mode === 'main') {
          value = getValue(this.data, lines[k].info.label, index);
        } else {
          value = getValue(this.getData(lines[k].ds.key), lines[k].info.label, index);
        }
        info = formatInfo(value, lines[k].info.format, this.static.decimal);
        out.push({ index: k, txt: lines[k].info.txt, value: info });
      } else {
        out.push({ index: k, txt: lines[k].info.txt });
      }
    }
    return out;
  }
  // //////////////////////////////////////////////
  // name是唯一的名字，名字一样会覆盖以前同名的类，
  // className是调用什么类型的图，目前只支持 Line Order Button Scroll
  // usercfg指该图特殊的配置
  // callback 表示鼠标移动时返回的当前记录数据
  // //////////////////////////////////////////////
  this.createChart = function (name, className, usercfg, callback) {
    if (!inArray(className, [
      ClChartButton,
      ClChartLine,
      ClChartOrder,
      ClChartScroll
    ])) return undefined;

    const chart = new className(this);

    chart.name = name;
    this.childCharts[name] = chart;

    // this.bindEvent(chart);
    chart.init(usercfg, callback); // 根据用户配置初始化信息框

    return chart;
  }

  // 以下是chart画图的接口
  this.onPaint = function (chart) { // 需要重画时调用
    this.fastDrawBegin();
    for (const key in this.childCharts) {
      if (chart !== undefined) {
        if (this.childCharts[key] === chart) {
          this.childCharts[key].onPaint();
        }
      } else {
        this.childCharts[key].onPaint();
      }
    }
    // this.fastDrawEnd();
  }
  // 用于同一组多图只取一次数据，这样可以加速显示，程序结构不会乱
  this.fastDrawBegin = function () {
    if (!this.fastDraw) {
      this.fastBuffer = [];
      this.fastDraw = true;
    }
  }
  this.fastDrawEnd = function () {
    this.fastDraw = false;
  }

  // ///////////////////////////////////
  // 设置通用参数API
  // //////////////////////////////////
  this.setHideInfo = function (isHideInfo) {
    if (isHideInfo === undefined) return;
    if (isHideInfo !== this.linkInfo.hideInfo) {
      this.linkInfo.hideInfo = isHideInfo;
      this.onPaint();
    }
  }
  // 最多支持多级图层
  this.setColor = function (syscolor, chart) { // 设置背景颜色方案
    this.color = setColor(syscolor, _systemInfo.standard);
    if (chart === undefined) chart = this;
    for (const key in chart.childCharts) {
      chart.childCharts[key].color = this.color;
      if (chart.childCharts[key] !== undefined) {
        this.setColor(syscolor, chart.childCharts[key]);
      }
    }
    this.onPaint();
  }
  // ///////////////////////////////////
  //
  // //////////////////////////////////

  // this.makeLineData = function(data, key, formula, punit) {
  //   return this.datalayer.makeLineData(data, key, this.linkInfo.minIndex, this.linkInfo.maxIndex, formula);
  // }
}

export default ClChart;