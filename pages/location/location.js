Page({
    // 初始数据
    data: {
        mapName: '',       // 地图名字
        mapImage: '',      // 地图图片 url

        // 上次由 Wifi 估计到的位置
        pointEstimatedByWifi: {
            x: 375,
            y: 375
        },

        // 当前由 Wifi 和传感器共同估计到的位置
        pointEstimatedCombined: {
            x: 0,
            y: 0
        },
        locations: [],     // 各个采集点对应的位置和 Wifi 列表
        wifiList: [],      // 当前位置扫描到的 Wifi 列表
        wifiMap: {},       // 当前位置扫描到的 Wifi MAC 地址对应的 Wifi 和它们的预估位置
        updateTime: 0,     // 上次 Wifi 扫描结果发生变化的时间，毫秒
        lastAddTime: 0,    // 上次进行采集的时间，毫秒

        dx: 0,
        dy: 0,

        // 从传感器位移变成图上位移的比例系数和旋转角
        // 这个系数默认是 0，意味着刚开始学习的一段时间内暂不产生较大的传感器学习位移
        // 在迭代学习一段时间后，这个系数逐渐增大，传感器学习位移逐渐起作用
        sensorFactor: 0,

        // 从传感器位移变成图上位移的比例系数和旋转角
        sensorRotation: 0,
    },
    log(...args) {
        let arg0 = args[0];
        args = args.map((k) => (typeof k === 'object' ? JSON.stringify(k) : k)).join(' ');
        let { logs = [] } = this.data

        let found = -1;
        for (let i in logs) {
            if (logs[i].indexOf(arg0) === 0) {
                logs[i] = args;
                found = i;
                break;
            }
        }
        if (found === -1) {
            let maxSameLen = 0;
            for (let i in logs) {
                let samelen = 0;
                for (let j = 0; j < Math.min(logs[i].length, arg0.length); j++) {
                    if (logs[i][j] !== arg0[j]) {
                        break;
                    }
                    samelen++;
                }
                if (samelen && samelen >= maxSameLen) {
                    maxSameLen = samelen;
                    found = parseInt(i) + 1;
                }
            }
            if (found !== -1) {
                logs.splice(found, 0, args);
            } else {
                found = logs.length;
                logs.push(args);
            }
        }

        this.setData({ logs, lastRefreshLog: found });
    },
    showFail(msg) {
        wx.showModal({
            title: '错误',
            content: msg
        });
    },
    onLoad(options) {
        // 如果有分享来的数据，取出分享数据进行展示
        if (options.data) {
            this.setData(JSON.parse(options.data));
        } else {
            // 否则尝试取本地缓存数据，无缓存则用初始数据
            this.setData(wx.getStorageSync('wifi-location-data') || {});
        }

        this.setData({
            logs: [],
            dx: 0,
            dy: 0,
            pointEstimatedByWifi: { x: 0, y: 0 },
            pointEstimatedCombined: { x: 0, y: 0 },
            sensorFactor: 0,
            sensorRotation: 0,
        });
        
        let { platform } = wx.getSystemInfoSync();
        this.setData({ platform });
        this.log('设备平台', platform);

        if (platform === 'android') {
            // 启动 Wifi 扫描
            wx.startWifi({
                success: () => {
                    // 每隔 1 秒重新扫 Wifi，然后估算当前位置和各个 Wifi 的估计位置
                    setInterval(() => {
                        this.updateCurrentPoint();
                    }, 1000);
                },
                fail: () => {
                    this.showFail('开启 Wifi 扫描失败');
                }
            });
        } else {
            this.showFail('当前设备不支持');
        }

        this.initSensors();
    },
    onHide() {
        // 小程序关闭时将数据缓存在本地
        wx.setStorageSync('wifi-location-data', this.data);
    },
    onShareAppMessage() {
        // 转发分享时，将当前的采集点信息、地图名和地图图片 url 发送出去
        let { locations, mapName, mapImage, sensorFactor, sensorRotation } = this.data;
        return {
            title: '室内定位 - ' + (this.data.mapName || '新建地图'),
            path: '/pages/location/location?data=' + JSON.stringify({
                locations, mapName, mapImage, sensorFactor, sensorRotation
            })
        };
    },
    onNameInput(e) {
        // 输入地图名字，改变地图名字
        this.setData({
            mapName: e.detail.value
        });
    },
    onTap(e) {
        // 如果没有地图图片，选择并上传地图图片
        if (!this.data.mapImage) {
            this.chooseMapImage();
        } else {
            // 否则进行采集
            let { x, y } = e.detail;
            // 将事件点击的位置换算成相对于正方形地图区域的位置
            x = Math.round(x - e.currentTarget.offsetLeft);
            y = Math.round(y - e.currentTarget.offsetTop);
            this.addLocation({ x, y });
        }
    },
    chooseMapImage() {
        // 选择并上传地图图片
        wx.chooseImage({
            count: 1,
            sizeType: ['compressed'],
            sourceType: ['album'],
            // 得到已选图片，准备上传
            success: (res) => {
                wx.showLoading({
                    title: '上传中',
                });
                let filePath = res.tempFilePaths[0];
                // 获得当前小猴七牛key和token
                this.log('图片上传：本地路径', filePath);
                wx.request({
                    url: 'https://myseu.cn/ws3/api/qiniu',
                    success: (res) => {
                        let { key, uptoken: token } = res.data.result;
                        this.log('图片上传：凭据', { key, token });
                        // 将图片上传到七牛
                        wx.uploadFile({
                            url: 'https://up.qbox.me',
                            filePath,
                            name: 'file',
                            formData: { key, token },
                            success: (res) => {
                                wx.hideLoading();
                                // 得到图片地址，进行展示
                                let { url } = JSON.parse(res.data);
                                this.setData({ mapImage: url });
                                this.log('图片上传：地址', url);
                            },
                            fail: (e) => {
                                wx.hideLoading();
                                this.showFail('图片上传失败：' + e.errMsg);
                            }
                        });
                    },
                    fail: (e) => {
                        wx.hideLoading();
                        this.showFail('获取图片上传信息失败：' + e.errMsg);
                    }
                });
            },
        });
    },
    // 点击地图，进行采集
    addLocation({ x, y }) {
        this.log('位置采集', x, y);
        // 如果上次采集之后 Wifi 列表还没变，不让采集新的。上次采集wifi的时间晚于上次更新wifi的时间
        if (this.data.lastAddTime > this.data.updateTime) {
            wx.showFail('当前位置已采集，请等待重新扫描');
            return;
        }
        // 选择采集一次还是五次
        wx.showActionSheet({
            itemList: ['快速采集', '精确采集'],
            success: (res) => {
                // 如果采集一次，用 getWifiList，否则用 getPreciseWifiList，参数一样
                [this.getWifiList, this.getPreciseWifiList][res.tapIndex].call(this, (result) => {
                    this.log('采集：扫描 Wifi 完成，数量', Object.keys(result).length);
                    let { locations } = this.data;

                    // 构造已有采集点，用坐标和采集到的 wifi list（map）
                    let newLocation = {
                        point: { x, y },
                        wifiList: result
                    };

                    // 在之前已有的采集点中，去掉跟要采集的地点坐标相同的
                    locations = locations.filter((k) => k.point.x !== x || k.point.y !== y);

                    // 将当前地点添加到已有采集点
                    locations.push(newLocation);

                    // 更新界面上的采集点，更新最近采集时间
                    this.setData({
                        locations: locations,
                        lastAddTime: +new Date()
                    });
                    this.log('采集：添加 Wifi 采集点完成');

                    // 在 data 中的采集点更新完之后，利用新的采集点列表，更新估算自己位置和估算 Wifi 热点位置
                    this.updateCurrentPoint();
                    this.updateWifiEstimatedPoint();

                    wx.showToast({
                        title: '采集成功',
                    });
                });

                this.log('采集：进入 Wifi 热点位置估算');
                this.updateWifiEstimatedPoint();

                this.log('采集：进入传感器采集');
                this.sensorsPick({ x, y });
            }
        });
    },
    updateCurrentPoint() {
        // 更新估算自己位置
        // 首先更新 Wifi 列表再估算
        this.getWifiList((currentWifiList) => {
            this.log('刷新位置：Wifi 扫描完成');
            // 用当前搜到的 Wifi 列表来估算，即得到自己的估计位置
            let point = this.getEstimatedLocation(currentWifiList);
            this.log('刷新位置：Wifi 估测位置完成', point);
            this.setData({
                pointEstimatedByWifi: point
            });
            this.log('刷新位置：开始合并 Wifi 与传感器估测位置');
            this.combineSensorsPoint();
        })
    },
    // 更新各 Wifi 的估测位置
    updateWifiEstimatedPoint() {
        // 对于每个 Wifi
        for (let wifi of this.data.wifiList) {
            // 把这个 Wifi 的估测位置更新到 wifiMap 中
            let point = this.getEstimatedLocation({ [wifi.BSSID]: 100 });
            this.data.wifiMap[wifi.BSSID] = {
                wifi,
                // 把 Wifi 看做一个只搜到了自己的人
                // 模拟一个只搜到了它自己的 Wifi 列表，进行估算，即得到这个 Wifi 自己的估测位置
                estimatedPoint: point
            };
        }
        // 将 wifiMap 更新到界面
        this.setData({
            wifiMap: this.data.wifiMap
        })
    },
    // 传入当前搜索到的 wifi 信号对应的 object，返回估算的位置点
    // 用于：1. 通过传入用户搜到的 wifi，估算用户所在位置；
    //      2. 通过只传入 wifi 自己（并假设信号为 100），估算 wifi 热点所在位置。
    getEstimatedLocation(currentWifiList) {
        let { locations } = this.data;

        // 如果完全没有采集点，没法估测
        if (!locations.length) {
            return { x: 0, y: 0 };
        }

        // 用于保存所有可能接近的采集点及其距离
        let neighbors = [];

        // 对于每个采集点
        for (let location of locations) {
            let { point, wifiList } = location;

            // 求采集点的 Wifi MAC 列表和自己的 Wifi MAC 列表
            let macsA = Object.keys(wifiList);
            let macsB = Object.keys(currentWifiList);

            // 取交集，得到自己和这个采集点同时能搜到的 Wifi MAC 列表
            let intersect = macsB.filter((k) => macsA.find((x) => x == k));

            // 如果自己和这个采集点没法搜到任何共同 Wifi，直接 pass，接着看下一个采集点
            if (!intersect.length) {
                continue;
            }

            // 如果有共同 Wifi，求出相似度
            let similarity = 0;

            // 对于每个共同 Wifi，对信号强度之差的倒数进行累加得到相似度，值越大距离越近
            for (let mac of intersect) {
                similarity += 1 / Math.abs(currentWifiList[mac] - wifiList[mac]);
            }

            neighbors.push({
                point,
                similarity
            })
        }

        // 最后将所有可能是采集点的点的距离进行排序，取前三个点
        neighbors = neighbors.sort((a, b) => b.similarity - a.similarity).slice(0, 3);
        

        // 对这 3 个点做加权平均，用欧氏距离的平方的倒数作为权值
        //（距离越近权值越高，平方是为了加强距离远近的对权值大小的影响）
        let x = 0, y = 0, weight = 0;

        let maxW = 0;
        for (let neighbor of neighbors) {
            // 对每个点的坐标与权值乘积进行累加
            let w = 1 / Math.pow(neighbor.distance || 1, 2);
            maxW = Math.max(w, maxW);

            x += neighbor.point.x * w;
            y += neighbor.point.y * w;
            // 对权值进行累加
            weight += 1 * w;
        }
        
        // 如果完全没有邻居可能会导致除以零，这里规避一下
        weight = weight || 1;
        let point = {
            x: Math.round(x / weight),
            y: Math.round(y / weight)
        };

        this.log('位置估算：近邻数', neighbors.length, '总权值', weight, '最高权值', maxW, '估算结果', point);

        // 取加权平均坐标作为估测坐标
        return point;
    },
    // 获取当前 Wifi 扫描结果
    // 受限于机型问题，可能和上次结果相同
    getWifiList(callback) {
        if (this.data.platform !== 'android') {
            callback({});
            return;
        }

        wx.getWifiList({
            success: () => {
                this.setData({ wifiOff: false });
                wx.onGetWifiList(({ wifiList }) => {
                    this.log('扫描 Wifi：总热点数', wifiList.length);

                    // 过滤掉信号低于 75 的
                    wifiList = wifiList.filter((k) => k.signalStrength >= 75);
                    this.log('扫描 Wifi：初步筛选热点数', wifiList.length);

                    let result = {};
                    let wifiMap = this.data.wifiMap;
                    
                    for (let wifi of wifiList) {
                        // 为了节省存储空间，防止分享路径过长，需要尽可能缩短 MAC 地址
                        let { SSID, BSSID, signalStrength } = wifi;

                        // 返回结果是一个 map，以 MAC 为键，信号强度为值
                        result[BSSID] = signalStrength;
                    }
                    // 如果扫描结果和上次结果不同，则更新列表、更新扫描时间
                    if (JSON.stringify(this.data.wifiList) !== JSON.stringify(wifiList)) {
                        this.log('扫描 Wifi：与上次扫描结果比较', '不同');
                        this.setData({
                            wifiList,
                            updateTime: +new Date(),
                            wifiMap
                        });
                    } else {
                        this.log('扫描 Wifi：与上次扫描结果比较', '相同');
                    }
                    callback(result);
                });
            },
            fail: () => {
                this.setData({ wifiOff: true });
            }
        });
    },
    // 采集五次，每秒一次，将采集结果汇总
    getPreciseWifiList(callback) {
        wx.showLoading({
            title: '正在采集',
        })
        // 综合采集结果
        let comprehensive = {};

        // 异步循环需要递归，times 是当前的次数，默认第 0 次
        let pickOnce = (times = 0) => {
            this.log('精确扫描 Wifi，第', times, '次');

            // 每次扫一下 Wifi
            this.getWifiList((result) => {
                // 对于扫到的每个 Wifi
                for (let mac in result) {
                    // 如果之前没扫到，先初始化一下
                    if (!comprehensive[mac]) {
                        comprehensive[mac] = { sum: 0, count: 0 };
                    }
                    // 更新这个 Wifi 总的信号强度和扫到的次数
                    comprehensive[mac].sum += result[mac];
                    comprehensive[mac].count++;
                }
            })

            // 如果次数不够就 1 秒后递归
            if (times < 5) {
                setTimeout(() => pickOnce(times + 1), 1000);
            } else {
                this.log('精确扫描 Wifi 结束，热点总数', comprehensive.length);
                // 次数够了，对每个扫到的 Wifi 求出平均信号强度取整并返回
                for (let mac in comprehensive) {
                    comprehensive[mac] = Math.round(comprehensive[mac].sum / comprehensive[mac].count);
                }
                callback(comprehensive);
                wx.hideLoading();
            }
        }
        // 开始第一次扫描
        pickOnce();
    },
    initSensors() {
        let α = 0;
        let β = 0;
        let γ = 0;
        let vx = 0;
        let vy = 0;

        wx.stopDeviceMotionListening({
            complete: () => {
                wx.startDeviceMotionListening({
                    success: () => {
                        wx.onDeviceMotionChange(({ alpha, beta, gamma }) => {
                            alpha = Number(alpha.toFixed(2));
                            beta = Number(beta.toFixed(2));
                            gamma = Number(gamma.toFixed(2));
                            this.log('传感器：角度倾斜角', alpha, beta, gamma);

                            α = Number(((alpha / 180) * Math.PI).toFixed(3));
                            β = Number(((beta / 180) * Math.PI).toFixed(3));
                            γ = Number(((gamma / 180) * Math.PI).toFixed(3));

                            this.log('传感器：弧度倾斜角', α, β, γ);
                        });
                    },
                    fail: (e) => {
                        this.showFail('方向传感器初始化失败：' + e.errMsg);
                    }
                });
            }
        });

        wx.stopAccelerometer({
            complete: () => {
                wx.startAccelerometer({
                    interval: 'game',
                    success: () => {
                        wx.onAccelerometerChange(({ x, y, z }) => {
                            x = Number(x.toFixed(3));
                            y = Number(y.toFixed(3));
                            z = Number(z.toFixed(3));

                            this.log('传感器：设备含重加速度', x, y, z);

                            let { sin, cos } = Math;
                            let aEast = x * cos(α) * cos(γ) + y * sin(α) * cos(β) - z * sin(β) * sin(γ); //？
                            aEast = Math.round(aEast * 10) / 10;

                            let aNorth = y * cos(α) * cos(β) - x * sin(α) * cos(γ) + z * cos(α) * sin(β); //？
                            aNorth = Math.round(aNorth * 10) / 10;

                            this.log('传感器：地球坐标系加速度', aEast, aNorth);

                            vx += aEast;
                            vy += aNorth;
                            this.log('传感器：积分速度', vx, vy);

                            // 加速度极小时，认为设备趋向于静止，以便对速度进行校准
                            if (Math.abs(aEast) < 1 && Math.abs(aNorth) < 1) {
                                vx = Number((vx * Math.abs(aEast)).toFixed(5));
                                vy = Number((vy * Math.abs(aNorth)).toFixed(5));
                                this.log('传感器：自动静止校准，校准后速度', vx, vy);
                            }

                            let dx = Math.round((this.data.dx + vx) * 100) / 100;
                            let dy = Math.round((this.data.dy + vy) * 100) / 100;
                            this.log('传感器：积分位移', dx, dy);

                            this.setData({ dx, dy });

                            this.combineSensorsPoint();
                        });
                    },
                    fail: (e) => {
                        this.showFail('加速度传感器初始化失败：' + e.errMsg);
                    }
                });
            }
        });
    },
    combineSensorsPoint() {
        let { x, y } = this.data.pointEstimatedByWifi;
        let { dx, dy, sensorFactor, sensorRotation } = this.data;
        this.log('坐标合并开始，Wifi', x, y, '传感器', dx, dy);

        // 根据学习到的系数和旋转角，转换传感器位移，估测精细位移
        let d = Math.sqrt(dx * dx + dy * dy);
        let θ = dx && Math.atan(Math.abs(dy / dx));
        if (dx < 0) θ = Math.PI - θ;
        if (dy < 0) θ = -θ;
        this.log('坐标合并：原始模', d, '角', θ);

        d *= sensorFactor;
        θ += sensorRotation;
        this.log('坐标合并：规格化比例系数', sensorFactor, '旋转角', sensorRotation);
        this.log('坐标合并：规格化模', d, '角', θ);

        dx = d * Math.cos(θ);
        dy = d * Math.sin(θ);
        this.log('坐标合并：分量结果', dx, dy);

        x += dx;
        y += dy;
        let pointEstimatedCombined = { x, y };
        this.log('坐标合并完成', pointEstimatedCombined);

        this.setData({ pointEstimatedCombined });
    },
    sensorsPick(point) {
        let { x: x0 = 0, y: y0 = 0 } = this.data.lastSensorPickPoint || {};
        let { x: x1, y: y1 } = point;

        this.log('传感器采集：上次采集点', x0, y0);
        this.log('传感器采集：本次采集点', x1, y1);
        this.data.lastSensorPickPoint = point;

        let { dx, dy } = this.data;
        let wdx = x1 - x0;
        let wdy = y1 - y0;
        this.log('传感器采集：采集点位移', wdx, wdy);
        this.log('传感器采集：传感器位移', dx, dy);

        // 取出从上次采集到本次采集之间传感器检测到的位移
        // 并清空这个位移，以便重新开始累积位移供下次使用
        this.setData({ dx: 0, dy: 0 });

        // 如果是第一次采集，剔除
        if (!x0 && !y0) {
            return;
        }

        // 如果本次跟上次采集点距离很近，排除
        // 否则，对横纵坐标中变化较小者进行归零
        if (Math.abs(wdx) < 10 && Math.abs(wdy) < 10) {
            this.log('传感器采集：采集点距离过小');
            return;
        } else if (Math.abs(wdx) < 10) {
            this.log('传感器采集：采集点水平正交化');
            x1 = x0;
        } else if (Math.abs(wdy) < 10) {
            this.log('传感器采集：采集点垂直正交化');
            y1 = y0;
        }

        // 如果本次跟上次传感器位置变化不大，排除
        // 否则，对横纵坐标中变化较小者进行归零
        if (Math.abs(dx) < 0.1 && Math.abs(dy) < 0.1) {
            this.log('传感器采集：传感器位移过小');
            return;
        } else if (Math.abs(dx) < 0.1) {
            this.log('传感器采集：位移水平正交化');
            dx = 0;
        } else if (Math.abs(dy) < 0.1) {
            this.log('传感器采集：位移垂直正交化');
            dy = 0;
        }

        // 采集点发生变化，对采集点位移量与传感器位移量进行比较，得到旋转角和系数
        // 利用本次的旋转角和系数来对累积的旋转角和系数进行迭代，优化结果，逐渐学习到接近准确的旋转角和系数

        // 求采集点位移量的模和角度
        let wd = Math.sqrt(wdx * wdx + wdy * wdy);
        let wθ = wdx && Math.atan(Math.abs(wdy / wdx));
        if (wdx < 0) wθ = Math.PI - wθ;
        if (wdy < 0) wθ = -wθ;
        this.log('传感器采集：采集点位移模', wd, '角', wθ);

        // 求传感器位移量的模和角度
        let d = Math.sqrt(dx * dx + dy * dy);
        let θ = dx && Math.atan(Math.abs(dy / dx));
        if (dx < 0) θ = Math.PI - θ;
        if (dy < 0) θ = -θ;
        this.log('传感器采集：传感器位移模', d, '角', θ);

        // 求本次两个位移量之间的系数和夹角
        let factor = wd / d;
        let rotation = wθ - θ;
        this.log('传感器采集：模比', factor, '角差', rotation);

        // 利用本次求得的系数和夹角，对之前的系数和夹角进行 20% 的迭代学习
        let { sensorFactor, sensorRotation } = this.data;
        this.log('传感器采集：模比迭代前', sensorFactor);
        sensorFactor = sensorFactor * 0.8 + factor * 0.2;
        this.log('传感器采集：模比迭代后', sensorFactor);

        // 通过诱导，使本次得到的旋转角与之前学习的旋转角处于同一个半周之内
        // 保证迭代过程向两者的内夹角方向进行
        while (Math.abs(sensorRotation - rotation) > Math.PI) {
            if (sensorRotation > rotation) {
                rotation += 2 * Math.PI;
            } else {
                sensorRotation += 2 * Math.PI;
            }
            this.log('传感器采集：角诱导', rotation, sensorRotation);
        }

        // 可以进行迭代了
        this.log('传感器采集：角差迭代前', sensorRotation);
        sensorRotation = sensorRotation * 0.8 + rotation * 0.2;
        this.log('传感器采集：角差迭代后', sensorRotation);

        // 本次迭代后，对角度值进行规格化
        sensorRotation = sensorRotation % (2 * Math.PI);
        this.log('传感器采集：角差规格化后', sensorRotation);

        // 更新学习到的最新系数和旋转角
        this.log('传感器采集完成', sensorFactor, sensorRotation);
        this.setData({ sensorFactor, sensorRotation });
    },
    clear() {
        // 重置地图
        wx.showModal({
            title: '重置',
            content: '是否确认重置地图，重新采集？',
            success: (res) => {
                if (res.confirm) {
                    this.setData({
                        mapName: '',
                        mapImage: '',
                        pointEstimatedByWifi: {
                            x: 0,
                            y: 0
                        },
                        pointEstimatedCombined: {
                            x: 0,
                            y: 0
                        },
                        locations: [],     // 采集点的位置坐标和对应的 Wifi 列表
                        wifiList: [],      // 当前扫描到的 Wifi 列表
                        wifiMap: {},
                        updateTime: 0,
                        lastAddTime: 0
                    })
                }
            }
        });
    }
});